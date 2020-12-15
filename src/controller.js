const { toBN } = require('web3-utils')
const Web3 = require('web3')
const {
  bitsToNumber,
  toFixedHex,
  poseidonHash,
  poseidonHash2,
  getExtRewardArgsHash,
  getExtWithdrawArgsHash,
  packEncryptedMessage,
  RewardArgs,
} = require('./utils')
const Account = require('./account')
const MerkleTree = require('fixed-merkle-tree')
const websnarkUtils = require('websnark/src/utils')
const buildGroth16 = require('websnark/src/groth16')

const web3 = new Web3()

class Controller {
  constructor({ contract, tornadoTreesContract, merkleTreeHeight, provingKeys, groth16 }) {
    this.merkleTreeHeight = Number(merkleTreeHeight)
    this.provingKeys = provingKeys
    this.contract = contract
    this.tornadoTreesContract = tornadoTreesContract
    this.groth16 = groth16
  }

  async init() {
    this.groth16 = await buildGroth16()
  }

  async _fetchAccountCommitments() {
    const events = await this.contract.getPastEvents('NewAccount', {
      fromBlock: 0,
      toBlock: 'latest',
    })
    return events
      .sort((a, b) => a.returnValues.index - b.returnValues.index)
      .map((e) => toBN(e.returnValues.commitment))
  }

  _fetchDepositDataEvents() {
    return this._fetchEvents('DepositData')
  }

  _fetchWithdrawalDataEvents() {
    return this._fetchEvents('WithdrawalData')
  }

  async _fetchEvents(eventName) {
    const events = await this.tornadoTreesContract.getPastEvents(eventName, {
      fromBlock: 0,
      toBlock: 'latest',
    })
    return events
      .sort((a, b) => a.returnValues.index - b.returnValues.index)
      .map((e) => ({
        instance: toFixedHex(e.returnValues.instance, 20),
        hash: toFixedHex(e.returnValues.hash),
        block: Number(e.returnValues.block),
        index: Number(e.returnValues.index),
      }))
  }

  _updateTree(tree, element) {
    const oldRoot = tree.root()
    tree.insert(element)
    const newRoot = tree.root()
    const { pathElements, pathIndices } = tree.path(tree.elements().length - 1)
    return {
      oldRoot,
      newRoot,
      pathElements,
      pathIndices: bitsToNumber(pathIndices),
    }
  }

  async batchReward({ account, notes, publicKey, fee = 0, relayer = 0 }) {
    const accountCommitments = await this._fetchAccountCommitments()
    let lastAccount = account
    const proofs = []
    for (const note of notes) {
      const proof = await this.reward({
        account: lastAccount,
        note,
        publicKey,
        fee,
        relayer,
        accountCommitments: accountCommitments.slice(),
      })
      proofs.push(proof)
      lastAccount = proof.account
      accountCommitments.push(lastAccount.commitment)
    }
    const args = proofs.map((x) => web3.eth.abi.encodeParameters(['bytes', RewardArgs], [x.proof, x.args]))
    return { proofs, args }
  }

  async reward({ account, note, publicKey, fee = 0, relayer = 0, accountCommitments = null }) {
    const rate = await this.contract.methods.rates(note.instance).call()

    const newAmount = account.amount.add(
      toBN(rate)
        .mul(toBN(note.withdrawalBlock).sub(toBN(note.depositBlock)))
        .sub(toBN(fee)),
    )
    const newAccount = new Account({ amount: newAmount })

    const depositDataEvents = await this._fetchDepositDataEvents()
    const depositLeaves = depositDataEvents.map((x) => poseidonHash([x.instance, x.hash, x.block]))
    const depositTree = new MerkleTree(this.merkleTreeHeight, depositLeaves, { hashFunction: poseidonHash2 })
    const depositItem = depositDataEvents.filter((x) => x.hash === toFixedHex(note.commitment))
    if (depositItem.length === 0) {
      throw new Error('The deposits tree does not contain such note commitment')
    }
    const depositPath = depositTree.path(depositItem[0].index)

    const withdrawalDataEvents = await this._fetchWithdrawalDataEvents()
    const withdrawalLeaves = withdrawalDataEvents.map((x) => poseidonHash([x.instance, x.hash, x.block]))
    const withdrawalTree = new MerkleTree(this.merkleTreeHeight, withdrawalLeaves, {
      hashFunction: poseidonHash2,
    })
    const withdrawalItem = withdrawalDataEvents.filter((x) => x.hash === toFixedHex(note.nullifierHash))
    if (withdrawalItem.length === 0) {
      throw new Error('The withdrawals tree does not contain such note nullifier')
    }
    const withdrawalPath = withdrawalTree.path(withdrawalItem[0].index)

    accountCommitments = accountCommitments || (await this._fetchAccountCommitments())
    const accountTree = new MerkleTree(this.merkleTreeHeight, accountCommitments, {
      hashFunction: poseidonHash2,
    })
    const zeroAccount = {
      pathElements: new Array(this.merkleTreeHeight).fill(0),
      pathIndices: new Array(this.merkleTreeHeight).fill(0),
    }
    const accountIndex = accountTree.indexOf(account.commitment, (a, b) => a.eq(b))
    const accountPath = accountIndex !== -1 ? accountTree.path(accountIndex) : zeroAccount
    const accountTreeUpdate = this._updateTree(accountTree, newAccount.commitment)

    const encryptedAccount = packEncryptedMessage(newAccount.encrypt(publicKey))
    const extDataHash = getExtRewardArgsHash({ relayer, encryptedAccount })

    const input = {
      rate,
      fee,
      instance: note.instance,
      rewardNullifier: note.rewardNullifier,
      extDataHash,

      noteSecret: note.secret,
      noteNullifier: note.nullifier,

      inputAmount: account.amount,
      inputSecret: account.secret,
      inputNullifier: account.nullifier,
      inputRoot: accountTreeUpdate.oldRoot,
      inputPathElements: accountPath.pathElements,
      inputPathIndices: bitsToNumber(accountPath.pathIndices),
      inputNullifierHash: account.nullifierHash,

      outputAmount: newAccount.amount,
      outputSecret: newAccount.secret,
      outputNullifier: newAccount.nullifier,
      outputRoot: accountTreeUpdate.newRoot,
      outputPathIndices: accountTreeUpdate.pathIndices,
      outputPathElements: accountTreeUpdate.pathElements,
      outputCommitment: newAccount.commitment,

      depositBlock: note.depositBlock,
      depositRoot: depositTree.root(),
      depositPathIndices: bitsToNumber(depositPath.pathIndices),
      depositPathElements: depositPath.pathElements,

      withdrawalBlock: note.withdrawalBlock,
      withdrawalRoot: withdrawalTree.root(),
      withdrawalPathIndices: bitsToNumber(withdrawalPath.pathIndices),
      withdrawalPathElements: withdrawalPath.pathElements,
    }

    const proofData = await websnarkUtils.genWitnessAndProve(
      this.groth16,
      input,
      this.provingKeys.rewardCircuit,
      this.provingKeys.rewardProvingKey,
    )
    const { proof } = websnarkUtils.toSolidityInput(proofData)

    const args = {
      rate: toFixedHex(input.rate),
      fee: toFixedHex(input.fee),
      instance: toFixedHex(input.instance, 20),
      rewardNullifier: toFixedHex(input.rewardNullifier),
      extDataHash: toFixedHex(input.extDataHash),
      depositRoot: toFixedHex(input.depositRoot),
      withdrawalRoot: toFixedHex(input.withdrawalRoot),
      extData: {
        relayer: toFixedHex(relayer, 20),
        encryptedAccount,
      },
      account: {
        inputRoot: toFixedHex(input.inputRoot),
        inputNullifierHash: toFixedHex(input.inputNullifierHash),
        outputRoot: toFixedHex(input.outputRoot),
        outputPathIndices: toFixedHex(input.outputPathIndices),
        outputCommitment: toFixedHex(input.outputCommitment),
      },
    }

    return {
      proof,
      args,
      account: newAccount,
    }
  }

  async withdraw({ account, amount, recipient, publicKey, fee = 0, relayer = 0 }) {
    const newAmount = account.amount.sub(toBN(amount)).sub(toBN(fee))
    const newAccount = new Account({ amount: newAmount })

    const accountCommitments = await this._fetchAccountCommitments()
    const accountTree = new MerkleTree(this.merkleTreeHeight, accountCommitments, {
      hashFunction: poseidonHash2,
    })
    const accountIndex = accountTree.indexOf(account.commitment, (a, b) => a.eq(b))
    if (accountIndex === -1) {
      throw new Error('The accounts tree does not contain such account commitment')
    }
    const accountPath = accountTree.path(accountIndex)
    const accountTreeUpdate = this._updateTree(accountTree, newAccount.commitment)

    const encryptedAccount = packEncryptedMessage(newAccount.encrypt(publicKey))
    const extDataHash = getExtWithdrawArgsHash({ fee, recipient, relayer, encryptedAccount })

    const input = {
      amount: toBN(amount).add(toBN(fee)),
      extDataHash,

      inputAmount: account.amount,
      inputSecret: account.secret,
      inputNullifier: account.nullifier,
      inputNullifierHash: account.nullifierHash,
      inputRoot: accountTreeUpdate.oldRoot,
      inputPathIndices: bitsToNumber(accountPath.pathIndices),
      inputPathElements: accountPath.pathElements,

      outputAmount: newAccount.amount,
      outputSecret: newAccount.secret,
      outputNullifier: newAccount.nullifier,
      outputRoot: accountTreeUpdate.newRoot,
      outputPathIndices: accountTreeUpdate.pathIndices,
      outputPathElements: accountTreeUpdate.pathElements,
      outputCommitment: newAccount.commitment,
    }

    const proofData = await websnarkUtils.genWitnessAndProve(
      this.groth16,
      input,
      this.provingKeys.withdrawCircuit,
      this.provingKeys.withdrawProvingKey,
    )
    const { proof } = websnarkUtils.toSolidityInput(proofData)

    const args = {
      amount: toFixedHex(input.amount),
      extDataHash: toFixedHex(input.extDataHash),
      extData: {
        fee: toFixedHex(fee),
        recipient: toFixedHex(recipient, 20),
        relayer: toFixedHex(relayer, 20),
        encryptedAccount,
      },
      account: {
        inputRoot: toFixedHex(input.inputRoot),
        inputNullifierHash: toFixedHex(input.inputNullifierHash),
        outputRoot: toFixedHex(input.outputRoot),
        outputPathIndices: toFixedHex(input.outputPathIndices),
        outputCommitment: toFixedHex(input.outputCommitment),
      },
    }

    return {
      proof,
      args,
      account: newAccount,
    }
  }

  async treeUpdate(commitment, accountTree = null) {
    if (!accountTree) {
      const accountCommitments = await this._fetchAccountCommitments()
      accountTree = new MerkleTree(this.merkleTreeHeight, accountCommitments, {
        hashFunction: poseidonHash2,
      })
    }
    const accountTreeUpdate = this._updateTree(accountTree, commitment)

    const input = {
      oldRoot: accountTreeUpdate.oldRoot,
      newRoot: accountTreeUpdate.newRoot,
      leaf: commitment,
      pathIndices: accountTreeUpdate.pathIndices,
      pathElements: accountTreeUpdate.pathElements,
    }

    const proofData = await websnarkUtils.genWitnessAndProve(
      this.groth16,
      input,
      this.provingKeys.treeUpdateCircuit,
      this.provingKeys.treeUpdateProvingKey,
    )
    const { proof } = websnarkUtils.toSolidityInput(proofData)

    const args = {
      oldRoot: toFixedHex(input.oldRoot),
      newRoot: toFixedHex(input.newRoot),
      leaf: toFixedHex(input.leaf),
      pathIndices: toFixedHex(input.pathIndices),
    }

    return {
      proof,
      args,
    }
  }
}

module.exports = Controller
