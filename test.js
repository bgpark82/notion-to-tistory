const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const fs = require("fs")
const { exec } = require('node:child_process')
// or
// import {NotionToMarkdown} from "notion-to-md";

const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
})

const notion = new Client({
  auth: "secret_auRdiF8pmmh0s5ejoEHhrzgOOd1WfqmheOB1kjtqtQq",
});

// passing notion client to the option
// 4f9c895175fb4fdc96e9f932e0759c3b
const n2m = new NotionToMarkdown({ notionClient: notion });

(async () => {
  readline.question(`what is notion page id? `, async(pageId) => {
    console.log(`pageId=${pageId}`)
    const mdblocks = await n2m.pageToMarkdown(pageId);
    const mdString = await n2m.toMarkdownString(mdblocks);
    await write(pageId, mdString);
    await upload(`${pageId}.md`)
    
    console.log(`succeess`)
    readline.close();
  })

})();

const write = async (pageId, mdString) => {
  await fs.writeFile(`${pageId}.md`, mdString, (err) => {
    console.log(err);
  });
  console.log('export markdown successfully')
}

const upload = async (md) => {
  await exec(`markdown-tistory write ${md}`, async (err, output) => {
    console.log(`${md} will be uploaded soon`)
    if(err) {
      console.err(err)
      return
    }
    await console.log(output)
  })
}


