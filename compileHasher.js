// Generates Hasher artifact at compile-time using Truffle's external compiler
// mechanism
const path = require('path')
const fs = require('fs')
const genContract = require('circomlib/src/poseidon_gencontract.js')

// where Truffle will expect to find the results of the external compiler
// command
const outputPath = path.join(__dirname, 'build', 'contracts')
const outputPath2 = path.join(outputPath, 'Hasher2.json')
const outputPath3 = path.join(outputPath, 'Hasher3.json')

if (!fs.existsSync(outputPath)) {
  fs.mkdirSync(outputPath, { recursive: true })
}

function main() {
  const contract2 = {
    contractName: 'Hasher2',
    abi: genContract.generateABI(2),
    bytecode: genContract.createCode(2),
  }

  fs.writeFileSync(outputPath2, JSON.stringify(contract2, null, 2))

  const contract3 = {
    contractName: 'Hasher3',
    abi: genContract.generateABI(3),
    bytecode: genContract.createCode(3),
  }

  fs.writeFileSync(outputPath3, JSON.stringify(contract3, null, 2))
}

main()
