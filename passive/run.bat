@echo off
cd /d "D:\Program Files Dev\opencode-feishu\passive"
start /b "" node dist\index.js >> logs\passive.log 2>&1
