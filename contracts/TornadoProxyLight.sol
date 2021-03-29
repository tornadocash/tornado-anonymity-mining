// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;
import "./interfaces/ITornadoInstance.sol";

contract TornadoProxyLight {
  event EncryptedNote(address indexed sender, bytes encryptedNote);

  function deposit(
    ITornadoInstance _tornado,
    bytes32 _commitment,
    bytes calldata _encryptedNote
  ) external payable {
    _tornado.deposit{ value: msg.value }(_commitment);
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
    _tornado.withdraw{ value: msg.value }(_proof, _root, _nullifierHash, _recipient, _relayer, _fee, _refund);
  }

  function backupNotes(bytes[] calldata _encryptedNotes) external {
    for (uint256 i = 0; i < _encryptedNotes.length; i++) {
      emit EncryptedNote(msg.sender, _encryptedNotes[i]);
    }
  }
}
