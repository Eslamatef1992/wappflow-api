// PM2: pm2 start deploy/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'wappflow',
      cwd: __dirname + '/..',
      script: 'src/index.js',
      instances: 1, // the background worker runs here; scale extra API instances with WORKER=false
      env: { NODE_ENV: 'production' },
      max_memory_restart: '600M',
      time: true,
    },
  ],
};
