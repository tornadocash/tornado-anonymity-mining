// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "./interfaces/ITornadoInstance.sol";
import "./interfaces/ITornadoTrees.sol";

contract TornadoProxy {
  using SafeERC20 for IERC20;

  event EncryptedNote(address indexed sender, bytes encryptedNote);
  event InstanceStateUpdate(address indexed instance, InstanceState state);

  enum InstanceState { Disabled, Enabled, Mineable }
  struct Instance {
    ITornadoInstance instance;
    InstanceState state;
    bool isERC20;
  }

  ITornadoTrees public tornadoTrees;
  address public immutable governance;
  mapping(ITornadoInstance => InstanceState) public instances;

  modifier onlyGovernance() {
    require(msg.sender == governance, "Not authorized");
    _;
  }

  constructor(
    address _tornadoTrees,
    address _governance,
    Instance[] memory _instances
  ) public {
    tornadoTrees = ITornadoTrees(_tornadoTrees);
    governance = _governance;

    for (uint256 i = 0; i < _instances.length; i++) {
      _updateInstance(_instances[i]);
    }
  }

  function deposit(
    ITornadoInstance _tornado,
    bytes32 _commitment,
    bytes calldata _encryptedNote
  ) external payable {
    require(instances[_tornado] != InstanceState.Disabled, "The instance is not supported");

    IERC20(_tornado.token()).safeTransferFrom(msg.sender, address(this), _tornado.denomination());
    _tornado.deposit{ value: msg.value }(_commitment);

    if (instances[_tornado] == InstanceState.Mineable) {
      tornadoTrees.registerDeposit(address(_tornado), _commitment);
    }
    emit EncryptedNote(msg.sender, _encryptedNote);
  }

  function withdraw(
    ITornadoInstance _tornado,
    bytes calldata _proof,
    bytes32 _root,
    bytes32 _nullifierHash,
    address payable _recipient,
    address payable _relayer,
    uint256 _fee,
    uint256 _refund
  ) external payable {
    require(instances[_tornado] != InstanceState.Disabled, "The instance is not supported");

    _tornado.withdraw{ value: msg.value }(_proof, _root, _nullifierHash, _recipient, _relayer, _fee, _refund);
    if (instances[_tornado] == InstanceState.Mineable) {
      tornadoTrees.registerWithdrawal(address(_tornado), _nullifierHash);
    }
  }

  function updateInstance(Instance calldata _instance) external onlyGovernance {
    _updateInstance(_instance);
    emit InstanceStateUpdate(address(_instance), _state);
  }

  function setTornadoTreesContract(address _tornadoTrees) external onlyGovernance {
    tornadoTrees = ITornadoTrees(_tornadoTrees);
  }

  /// @dev Method to claim junk and accidentally sent tokens
  function rescueTokens(
    IERC20 _token,
    address payable _to,
    uint256 _balance
  ) external onlyGovernance {
    require(_to != address(0), "TORN: can not send to zero address");

    if (_token == IERC20(0)) {
      // for Ether
      uint256 totalBalance = address(this).balance;
      uint256 balance = _balance == 0 ? totalBalance : Math.min(totalBalance, _balance);
      _to.transfer(balance);
    } else {
      // any other erc20
      uint256 totalBalance = _token.balanceOf(address(this));
      uint256 balance = _balance == 0 ? totalBalance : Math.min(totalBalance, _balance);
      require(balance > 0, "TORN: trying to send 0 balance");
      _token.safeTransfer(_to, balance);
    }
  }

  function _updateInstance(Instance memory _tornado) internal {
    instances[_tornado.instance] = _tornado.state;
    if (_tornado.isERC20) {
      IERC20 token = IERC20(_tornado.instance.token());
      token.safeApprove(address(_tornado.instance), uint256(-1));
    }
  }
}
