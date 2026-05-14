// 此文件用于测试 ESLint 规则，包含各种 process.env 使用形式
// 预期：所有用法都应被 no-restricted-syntax 规则捕获

// 点号访问
const apiKey = process.env.API_KEY;

// 括号访问（单引号）
const port = process.env['PORT'];

// 括号访问（双引号）
const host = process.env["HOST"];

// 解构赋值
const { NODE_ENV, DEBUG } = process.env;
