import path from 'path'
import execa from 'execa'
import process from 'process'

const codemods = [`gatsby-plugin-image`, `global-graphql-calls`, `import-link`, `navigate-calls`, `rename-bound-action-creators`]

export const transformerDirectory = path.join(__dirname, '../', 'transforms')
export const jscodeshiftExecutable = require.resolve('.bin/jscodeshift')

export function runTransform(transform, targetDir) {
  const transformerPath = path.join(transformerDirectory, `${transform}.js`)

  let args = []

  args.push('--ignore-pattern=**/node_modules/**') //TODO ignore cache and public
  args.push('--extensions=jsx,js,ts,tsx')
  
  args = args.concat(['--transform', transformerPath, targetDir])

  console.log(`Executing command: jscodeshift ${args.join(' ')}`);

  const result = execa.sync(jscodeshiftExecutable, args, {
    stdio: 'inherit',
    stripEof: false
  })

  if (result.error) {
    throw result.error
  }
}
  
export function run() {
  let userInput = process.argv

  const transform = userInput[2]
  let targetDir = userInput[3]


  if (!transform) {
    console.log(`Be sure to pass in the name of the codemod you're attempting to run.`)
    return
  }

  if (!codemods.includes(transform)) {
    console.log(`You have passed in invalid codemod name: ${transform}. Please pass a valid one.`)
    return
  }

  if(!targetDir) {
    console.log(`You have not provided a target directory to run the codemod against, will default to root.`)
    targetDir = `./`
    
  }
  runTransform(transform, targetDir)
}
