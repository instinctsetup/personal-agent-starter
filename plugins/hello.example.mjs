// Example plugin - rename to hello.mjs to activate.
export default {
  name: 'hello',
  commands: [
    {
      match: /^hello(?: (.*))?$/i,
      help: 'hello [name] - friendly greeting',
      run: async ({ args }) => `Hello${args[1] ? ' ' + args[1] : ''}! The plugin system works.`,
    },
  ],
};
