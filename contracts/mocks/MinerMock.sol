// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../Miner.sol";

contract MinerMock is Miner {
  uint256 public timestamp;

  constructor(
    bytes32 _rewardSwap,
    bytes32 _governance,
    bytes32 _tornadoTrees,
    bytes32[3] memory verifiers,
    bytes32 _accountRoot,
    Rate[] memory _rates
  ) public Miner(_rewardSwap, _governance, _tornadoTrees, verifiers, _accountRoot, _rates) {}

  function resolve(bytes32 _addr) public view override returns (address) {
    return address(uint160(uint256(_addr) >> (12 * 8)));
  }
}
