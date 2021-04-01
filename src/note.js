const { toBN, BN } = require('web3-utils')
const { randomBN, pedersenHashBuffer, poseidonHash } = require('./utils')

class Note {
  constructor({ secret, nullifier, netId, amount, currency, depositBlock, withdrawalBlock, instance } = {}) {
    this.secret = secret ? toBN(secret) : randomBN(31)
    this.nullifier = nullifier ? toBN(nullifier) : randomBN(31)

    this.commitment = pedersenHashBuffer(
      Buffer.concat([this.nullifier.toBuffer('le', 31), this.secret.toBuffer('le', 31)]),
    )
    this.nullifierHash = pedersenHashBuffer(this.nullifier.toBuffer('le', 31))
    this.rewardNullifier = poseidonHash([this.nullifier])

    this.netId = netId
    this.amount = amount
    this.currency = currency
    this.depositBlock = toBN(depositBlock)
    this.withdrawalBlock = toBN(withdrawalBlock)
    this.instance = instance || Note.getInstance(currency, amount)
  }

  static getInstance(/* currency, amount */) {
    // todo
  }

  static fromString(note, instance, depositBlock, withdrawalBlock) {
    const [, currency, amount, netId, noteHex] = note.split('-')
    const noteBuff = Buffer.from(noteHex.slice(2), 'hex')
    const nullifier = new BN(noteBuff.slice(0, 31), 16, 'le')
    const secret = new BN(noteBuff.slice(31), 16, 'le')
    return new Note({
      secret,
      nullifier,
      netId,
      amount,
      currency,
      depositBlock,
      withdrawalBlock,
      instance,
    })
  }
}

module.exports = Note
