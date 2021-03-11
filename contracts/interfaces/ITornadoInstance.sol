// SPDX-License-Identifier: MIT

pragma solidity ^0.6.0;

interface ITornadoInstance {
  function token() external returns (address);

  function denomination() external returns (uint256);

  function deposit(bytes32 commitment) external payable;

  function withdraw(
    bytes calldata proof,
    bytes32 root,
    bytes32 nullifierHash,
    address payable recipient,
    address payable relayer,
    uint256 fee,
    uint256 refund
  ) external payable;
}
