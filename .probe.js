const {tokenize,parseCommand}=require('./packages/permitter/lib/command-parser.js');
console.log(tokenize('foo # bar'));
console.log(tokenize('echo a #b'));
console.log(tokenize('echo "a # b" # c'));
console.log(tokenize('echo a#b'));
console.log(tokenize('npm run build # cleanup'));
