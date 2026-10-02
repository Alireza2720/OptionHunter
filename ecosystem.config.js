const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const envVars = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      envVars[key] = val;
    }
  });
}

module.exports = {
  apps: [
    {
      name: 'OptionHunter',
      script: './backend/server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '900M',
      // 🆕 V8 aware of the limit — خودش GC می‌کنه قبل از اینکه kill بشه
      node_args: '--max-old-space-size=850 --expose-gc',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        ...envVars
      },
      error_file: __dirname + '/logs/error.log',
      out_file: __dirname + '/logs/out.log',
      merge_logs: true,
      time: true
    },
   {
      // 🆕 Monitor — رصد مصرف سرور هر 30s (daemon mode)
      name: 'OHMonitor',
      script: './backend/scripts/monitor.js',
      args: '--daemon',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: __dirname + '/logs/monitor-error.log',
      out_file: __dirname + '/logs/monitor-out.log',
      merge_logs: true,
      time: true
    }
  ]
};