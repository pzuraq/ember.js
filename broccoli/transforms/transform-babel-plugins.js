const Babel = require('broccoli-babel-transpiler');

module.exports = function(tree) {
  let options = {
    sourceMaps: true,
    plugins: [
      ['@babel/plugin-proposal-decorators', { legacy: true }],
      ['@babel/plugin-proposal-class-properties'],
    ],
  };

  return new Babel(tree, options);
};
