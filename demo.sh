#!/bin/bash

# Demo script showing claw-browser usage

echo "========================================="
echo "claw-browser 使用演示"
echo "========================================="
echo ""

echo "[1] 导航到 example.com..."
node dist/index.js open example.com
echo ""

echo "[2] 获取页面快照（accessibility tree）..."
node dist/index.js snapshot | head -30
echo ""

echo "[3] 导航到 GitHub..."
node dist/index.js open github.com
echo ""

echo "[4] 截图..."
node dist/index.js screenshot | grep path
echo ""

echo "[5] 后退..."
node dist/index.js back
echo ""

echo "[6] 停止 default session..."
node dist/index.js stop default
echo ""

echo "========================================="
echo "演示完成！"
echo "========================================="
