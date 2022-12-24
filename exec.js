const { exec } = require('node:child_process') 

exec('ls .', (err, output) => {
    if(err) {
        console.err(err)
        return
    } console.log(output)
})