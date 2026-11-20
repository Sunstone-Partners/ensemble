const {tokenize,parseCommand}=require('./packages/permitter/lib/command-parser.js');
const t=(c)=>{try{return JSON.stringify(parseCommand(c))}catch(e){return 'THROW'}};
console.log(t('IFS=$x git status'));
console.log(tokenize('IFS=$x git status'));
console.log(t('IFS=$a b git status'));
console.log(tokenize('IFS=$a b git status'));
console.log(t("git status # don't run rm -rf /"));
console.log(t('env -C /tmp git status'));
