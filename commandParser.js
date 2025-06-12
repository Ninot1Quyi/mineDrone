class CommandParser {
    constructor() {
      // 你可以在这里维护允许的指令名列表
      this.allowedCommands = ['move', 'moveTo', 'turn'];
    }
  
    parse(message) {
      // 匹配 !指令名(参数1,参数2,...)
      const regex = /^!(\w+)\(([^)]*)\)$/i;
      const match = message.match(regex);
      if (!match) return null;
      const command = match[1];
      if (!this.allowedCommands.includes(command)) return null;
      // 参数按逗号分割并去除首尾空格
      const args = match[2].split(',').map(arg => arg.trim()).filter(arg => arg.length > 0);
      return { command, args };
    }
  }
  
  module.exports = CommandParser;
 