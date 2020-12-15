module.exports = {
  copyPackages: ['@openzeppelin/contracts'],
  testrpcOptions: '-d --accounts 10 --port 8555',
  skipFiles: ['Migrations.sol'],
}
