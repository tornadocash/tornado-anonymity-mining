// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../TornadoTrees.sol";

contract TornadoTreesMock is TornadoTrees {
  uint256 public timestamp;
  uint256 public currentBlock;

  constructor(
    bytes32 _tornadoProxy,
    bytes32 _hasher2,
    bytes32 _hasher3,
    uint32 _levels
  ) public TornadoTrees(_tornadoProxy, _hasher2, _hasher3, _levels) {}

  function resolve(bytes32 _addr) public view override returns (address) {
    return address(uint160(uint256(_addr) >> (12 * 8)));
  }

  function setBlockNumber(uint256 _blockNumber) public {
    currentBlock = _blockNumber;
  }

  function blockNumber() public view override returns (uint256) {
    return currentBlock == 0 ? block.number : currentBlock;
  }
}
