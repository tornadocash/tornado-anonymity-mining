// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;
import "../RewardSwap.sol";

contract RewardSwapMock is RewardSwap {
  uint256 public timestamp;

  constructor(
    bytes32 _torn,
    bytes32 _miner,
    uint256 _miningCap,
    uint256 _initialLiquidity,
    uint256 _poolWeight
  ) public RewardSwap(_torn, _miner, _miningCap, _initialLiquidity, _poolWeight) {
    timestamp = block.timestamp;
  }

  function setTimestamp(uint256 _timestamp) public {
    timestamp = _timestamp;
  }

  function resolve(bytes32 _addr) public view override returns (address) {
    return address(uint160(uint256(_addr) >> (12 * 8)));
  }

  function getTimestamp() public view override returns (uint256) {
    if (timestamp == 0) {
      return block.timestamp;
    }
    return timestamp;
  }
}
