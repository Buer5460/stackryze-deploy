'use strict';

const db = require('../lib/db');
const auth = require('../lib/auth');

function readPassword() {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('请在交互式终端中运行，以便安全输入密码。'));
  }
  process.stdout.write('管理员密码（至少 12 位，不回显）：');
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    function finish(error) {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(password);
    }
    function onData(chunk) {
      for (const char of String(chunk)) {
        if (char === '\u0003') return finish(new Error('已取消。'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') password = password.slice(0, -1);
        else if (char >= ' ' && char <= '~') password += char;
      }
    }
    input.on('data', onData);
  });
}

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('用法：npm run admin:create -- 管理员邮箱');
  await db.ensureLoaded();
  if (auth.findUserByEmail(email)) throw new Error('该邮箱已存在，请使用另一邮箱或通过后台管理现有用户。');
  const password = await readPassword();
  if (password.length < 12) throw new Error('管理员密码至少需要 12 位。');
  const user = auth.createUser({ email, password, display_name: email, role: 'ADMIN_SUPER', language: 'zh', is_demo: false });
  await db.commitNow();
  process.stdout.write('已创建平台管理员：' + user.email + '\n');
}

main().catch((error) => {
  process.stderr.write((error && error.message ? error.message : '创建管理员失败') + '\n');
  process.exitCode = 1;
});
