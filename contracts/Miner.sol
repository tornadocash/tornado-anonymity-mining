// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./interfaces/IVerifier.sol";
import "./interfaces/IRewardSwap.sol";
import "tornado-trees/contracts/TornadoTrees.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "torn-token/contracts/ENS.sol";

contract Miner is EnsResolve {
  using SafeMath for uint256;

  IVerifier public rewardVerifier;
  IVerifier public withdrawVerifier;
  IVerifier public treeUpdateVerifier;
  IRewardSwap public immutable rewardSwap;
  address public immutable governance;
  TornadoTrees public tornadoTrees;

  mapping(bytes32 => bool) public accountNullifiers;
  mapping(bytes32 => bool) public rewardNullifiers;
  mapping(address => uint256) public rates;

  uint256 public accountCount;
  uint256 public constant ACCOUNT_ROOT_HISTORY_SIZE = 100;
  bytes32[ACCOUNT_ROOT_HISTORY_SIZE] public accountRoots;

  event NewAccount(bytes32 commitment, bytes32 nullifier, bytes encryptedAccount, uint256 index);
  event RateChanged(address instance, uint256 value);
  event VerifiersUpdated(address reward, address withdraw, address treeUpdate);

  struct TreeUpdateArgs {
    bytes32 oldRoot;
    bytes32 newRoot;
    bytes32 leaf;
    uint256 pathIndices;
  }

  struct AccountUpdate {
    bytes32 inputRoot;
    bytes32 inputNullifierHash;
    bytes32 outputRoot;
    uint256 outputPathIndices;
    bytes32 outputCommitment;
  }

  struct RewardExtData {
    address relayer;
    bytes encryptedAccount;
  }

  struct RewardArgs {
    uint256 rate;
    uint256 fee;
    address instance;
    bytes32 rewardNullifier;
    bytes32 extDataHash;
    bytes32 depositRoot;
    bytes32 withdrawalRoot;
    RewardExtData extData;
    AccountUpdate account;
  }

  struct WithdrawExtData {
    uint256 fee;
    address recipient;
    address relayer;
    bytes encryptedAccount;
  }

  struct WithdrawArgs {
    uint256 amount;
    bytes32 extDataHash;
    WithdrawExtData extData;
    AccountUpdate account;
  }

  struct Rate {
    bytes32 instance;
    uint256 value;
  }

  modifier onlyGovernance() {
    require(msg.sender == governance, "Only governance can perform this action");
    _;
  }

  constructor(
    bytes32 _rewardSwap,
    bytes32 _governance,
    bytes32 _tornadoTrees,
    bytes32[3] memory _verifiers,
    bytes32 _accountRoot,
    Rate[] memory _rates
  ) public {
    rewardSwap = IRewardSwap(resolve(_rewardSwap));
    governance = resolve(_governance);
    tornadoTrees = TornadoTrees(resolve(_tornadoTrees));

    // insert empty tree root without incrementing accountCount counter
    accountRoots[0] = _accountRoot;

    _setRates(_rates);
    // prettier-ignore
    _setVerifiers([
      IVerifier(resolve(_verifiers[0])),
      IVerifier(resolve(_verifiers[1])),
      IVerifier(resolve(_verifiers[2]))
    ]);
  }

  function reward(bytes memory _proof, RewardArgs memory _args) public {
    reward(_proof, _args, new bytes(0), TreeUpdateArgs(0, 0, 0, 0));
  }

  function batchReward(bytes[] calldata _rewardArgs) external {
    for (uint256 i = 0; i < _rewardArgs.length; i++) {
      (bytes memory proof, RewardArgs memory args) = abi.decode(_rewardArgs[i], (bytes, RewardArgs));
      reward(proof, args);
    }
  }

  function reward(
    bytes memory _proof,
    RewardArgs memory _args,
    bytes memory _treeUpdateProof,
    TreeUpdateArgs memory _treeUpdateArgs
  ) public {
    validateAccountUpdate(_args.account, _treeUpdateProof, _treeUpdateArgs);
    tornadoTrees.validateRoots(_args.depositRoot, _args.withdrawalRoot);
    require(_args.extDataHash == keccak248(abi.encode(_args.extData)), "Incorrect external data hash");
    require(_args.fee < 2**248, "Fee value out of range");
    require(_args.rate == rates[_args.instance] && _args.rate > 0, "Invalid reward rate");
    require(!rewardNullifiers[_args.rewardNullifier], "Reward has been already spent");
    require(
      rewardVerifier.verifyProof(
        _proof,
        [
          uint256(_args.rate),
          uint256(_args.fee),
          uint256(_args.instance),
          uint256(_args.rewardNullifier),
          uint256(_args.extDataHash),
          uint256(_args.account.inputRoot),
          uint256(_args.account.inputNullifierHash),
          uint256(_args.account.outputRoot),
          uint256(_args.account.outputPathIndices),
          uint256(_args.account.outputCommitment),
          uint256(_args.depositRoot),
          uint256(_args.withdrawalRoot)
        ]
      ),
      "Invalid reward proof"
    );

    accountNullifiers[_args.account.inputNullifierHash] = true;
    rewardNullifiers[_args.rewardNullifier] = true;
    insertAccountRoot(_args.account.inputRoot == getLastAccountRoot() ? _args.account.outputRoot : _treeUpdateArgs.newRoot);
    if (_args.fee > 0) {
      rewardSwap.swap(_args.extData.relayer, _args.fee);
    }

    emit NewAccount(
      _args.account.outputCommitment,
      _args.account.inputNullifierHash,
      _args.extData.encryptedAccount,
      accountCount - 1
    );
  }

  function withdraw(bytes memory _proof, WithdrawArgs memory _args) public {
    withdraw(_proof, _args, new bytes(0), TreeUpdateArgs(0, 0, 0, 0));
  }

  function withdraw(
    bytes memory _proof,
    WithdrawArgs memory _args,
    bytes memory _treeUpdateProof,
    TreeUpdateArgs memory _treeUpdateArgs
  ) public {
    validateAccountUpdate(_args.account, _treeUpdateProof, _treeUpdateArgs);
    require(_args.extDataHash == keccak248(abi.encode(_args.extData)), "Incorrect external data hash");
    require(_args.amount < 2**248, "Amount value out of range");
    require(
      withdrawVerifier.verifyProof(
        _proof,
        [
          uint256(_args.amount),
          uint256(_args.extDataHash),
          uint256(_args.account.inputRoot),
          uint256(_args.account.inputNullifierHash),
          uint256(_args.account.outputRoot),
          uint256(_args.account.outputPathIndices),
          uint256(_args.account.outputCommitment)
        ]
      ),
      "Invalid withdrawal proof"
    );

    insertAccountRoot(_args.account.inputRoot == getLastAccountRoot() ? _args.account.outputRoot : _treeUpdateArgs.newRoot);
    accountNullifiers[_args.account.inputNullifierHash] = true;
    // allow submitting noop withdrawals (amount == 0)
    uint256 amount = _args.amount.sub(_args.extData.fee, "Amount should be greater than fee");
    if (amount > 0) {
      rewardSwap.swap(_args.extData.recipient, amount);
    }
    // Note. The relayer swap rate always will be worse than estimated
    if (_args.extData.fee > 0) {
      rewardSwap.swap(_args.extData.relayer, _args.extData.fee);
    }

    emit NewAccount(
      _args.account.outputCommitment,
      _args.account.inputNullifierHash,
      _args.extData.encryptedAccount,
      accountCount - 1
    );
  }

  function setRates(Rate[] memory _rates) external onlyGovernance {
    _setRates(_rates);
  }

  function setVerifiers(IVerifier[3] calldata _verifiers) external onlyGovernance {
    _setVerifiers(_verifiers);
  }

  function setTornadoTreesContract(TornadoTrees _tornadoTrees) external onlyGovernance {
    tornadoTrees = _tornadoTrees;
  }

  function setPoolWeight(uint256 _newWeight) external onlyGovernance {
    rewardSwap.setPoolWeight(_newWeight);
  }

  // ------VIEW-------

  /**
    @dev Whether the root is present in the root history
    */
  function isKnownAccountRoot(bytes32 _root, uint256 _index) public view returns (bool) {
    return _root != 0 && accountRoots[_index % ACCOUNT_ROOT_HISTORY_SIZE] == _root;
  }

  /**
    @dev Returns the last root
    */
  function getLastAccountRoot() public view returns (bytes32) {
    return accountRoots[accountCount % ACCOUNT_ROOT_HISTORY_SIZE];
  }

  // -----INTERNAL-------

  function keccak248(bytes memory _data) internal pure returns (bytes32) {
    return keccak256(_data) & 0x00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
  }

  function validateTreeUpdate(
    bytes memory _proof,
    TreeUpdateArgs memory _args,
    bytes32 _commitment
  ) internal view {
    require(_proof.length > 0, "Outdated account merkle root");
    require(_args.oldRoot == getLastAccountRoot(), "Outdated tree update merkle root");
    require(_args.leaf == _commitment, "Incorrect commitment inserted");
    require(_args.pathIndices == accountCount, "Incorrect account insert index");
    require(
      treeUpdateVerifier.verifyProof(
        _proof,
        [uint256(_args.oldRoot), uint256(_args.newRoot), uint256(_args.leaf), uint256(_args.pathIndices)]
      ),
      "Invalid tree update proof"
    );
  }

  function validateAccountUpdate(
    AccountUpdate memory _account,
    bytes memory _treeUpdateProof,
    TreeUpdateArgs memory _treeUpdateArgs
  ) internal view {
    require(!accountNullifiers[_account.inputNullifierHash], "Outdated account state");
    if (_account.inputRoot != getLastAccountRoot()) {
      // _account.outputPathIndices (= last tree leaf index) is always equal to root index in the history mapping
      // because we always generate a new root for each new leaf
      require(isKnownAccountRoot(_account.inputRoot, _account.outputPathIndices), "Invalid account root");
      validateTreeUpdate(_treeUpdateProof, _treeUpdateArgs, _account.outputCommitment);
    } else {
      require(_account.outputPathIndices == accountCount, "Incorrect account insert index");
    }
  }

  function insertAccountRoot(bytes32 _root) internal {
    accountRoots[++accountCount % ACCOUNT_ROOT_HISTORY_SIZE] = _root;
  }

  function _setRates(Rate[] memory _rates) internal {
    for (uint256 i = 0; i < _rates.length; i++) {
      require(_rates[i].value < 2**128, "Incorrect rate");
      address instance = resolve(_rates[i].instance);
      rates[instance] = _rates[i].value;
      emit RateChanged(instance, _rates[i].value);
    }
  }

  function _setVerifiers(IVerifier[3] memory _verifiers) internal {
    rewardVerifier = _verifiers[0];
    withdrawVerifier = _verifiers[1];
    treeUpdateVerifier = _verifiers[2];
    emit VerifiersUpdated(address(_verifiers[0]), address(_verifiers[1]), address(_verifiers[2]));
  }
}
