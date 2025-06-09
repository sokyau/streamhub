module.exports = {
  apps: [{
    name: 'streamhub',
    script: './server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '0.0.0.0',
      DB_PATH: './db/streamhub.db',
      UPLOAD_DIR: './uploads',
      TEMP_DIR: './temp',
      LOG_LEVEL: 'info'
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: 'localhost',
      DB_PATH: './db/streamhub.db',
      UPLOAD_DIR: './uploads',
      TEMP_DIR: './temp',
      LOG_LEVEL: 'debug'
    },
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_file: 'logs/combined.log',
    time: true,
    merge_logs: true,
    
    // Advanced PM2 features
    min_uptime: '10s',
    listen_timeout: 3000,
    kill_timeout: 5000,
    
    // Performance optimizations
    exec_mode: 'fork',
    
    // Auto-restart configurations
    cron_restart: '0 4 * * *', // Restart daily at 4 AM
    
    // Environment variable management
    instance_var: 'INSTANCE_ID',
    
    // Monitoring
    max_restarts: 10,
    min_uptime: 10000,
    
    // Post-deploy actions
    post_update: [
      'npm install',
      'node db-migrate.js'
    ]
  }],

  // Deployment configuration
  deploy: {
    production: {
      user: 'root',
      host: 'streamhub.sofe.site',
      ref: 'origin/main',
      repo: 'git@github.com:yourusername/streamhub.git',
      path: '/root/streamhub',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
      ssh_options: 'ForwardAgent=yes'
    }
  }
};
