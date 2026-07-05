import { spawnSync } from 'child_process';
import readline from 'readline';

// Get commit message from CLI arguments
let message = process.argv.slice(2).join(' ').trim();

async function run() {
  // If no message was provided via command line, prompt the user interactively
  if (!message) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    message = await new Promise((resolve) => {
      rl.question('\n📝 Por favor, ingresa el mensaje del commit: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!message) {
    console.error('\n❌ Error: El mensaje de commit no puede estar vacío.\n');
    process.exit(1);
  }

  console.log('\n🚀 Iniciando workflow de commit...');
  
  // 1. git add .
  console.log('\n📦 Ejecutando: git add .');
  const addResult = spawnSync('git', ['add', '.'], { stdio: 'inherit' });
  if (addResult.status !== 0) {
    console.error('\n❌ Error ejecutando git add .');
    process.exit(addResult.status || 1);
  }
  
  // 2. git commit -m "message"
  console.log(`\n💾 Ejecutando: git commit -m "${message}"`);
  const commitResult = spawnSync('git', ['commit', '-m', message], { stdio: 'inherit' });
  if (commitResult.status !== 0) {
    console.error('\n❌ Error ejecutando git commit.');
    process.exit(commitResult.status || 1);
  }
  
  // 3. git push
  console.log('\n📤 Ejecutando: git push');
  const pushResult = spawnSync('git', ['push'], { stdio: 'inherit' });
  if (pushResult.status !== 0) {
    console.error('\n❌ Error ejecutando git push.');
    process.exit(pushResult.status || 1);
  }
  
  console.log('\n✨ ¡Código subido con éxito al repositorio!\n');
}

run();
