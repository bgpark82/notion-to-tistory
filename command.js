// https://nodejs.dev/en/learn/accept-input-from-the-command-line-in-nodejs/

const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
})

readline.question(`What is your name?`, name => {
    console.log(`Hi ${name}`);
    readline.close();
})