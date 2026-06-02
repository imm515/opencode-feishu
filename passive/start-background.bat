@echo off
cd /d "D:\Program Files Dev\opencode-feishu\passive"
node dist/index.js > logs\passive.out.log 2> logs\passive.err.log
