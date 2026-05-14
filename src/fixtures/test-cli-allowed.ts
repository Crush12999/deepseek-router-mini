// 此文件模拟 cli.ts 的使用场景
// 预期：在 cli.ts 中允许使用 process.env（但此文件不是 cli.ts，所以会报错）

const args = process.argv;
const env = process.env.NODE_ENV;
