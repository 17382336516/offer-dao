module.exports = {
  apps: [{
    name: 'offerdao-api',
    script: 'start-all.mjs',
    cwd: '/var/www/offer-dao',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: '3000',
      HEADLESS: 'true',
      DEPLOY_ENV: 'aliyun'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file: '/var/log/offerdao/out.log',
    error_file: '/var/log/offerdao/err.log',
    merge_logs: true
  }]
};
