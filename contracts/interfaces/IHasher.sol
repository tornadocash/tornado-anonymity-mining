// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;

interface IHasher {
  function poseidon(bytes32[2] calldata inputs) external pure returns (bytes32);

  function poseidon(bytes32[3] calldata inputs) external pure returns (bytes32);
}
