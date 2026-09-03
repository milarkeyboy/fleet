-- Clangd-specific setup lives in its own module rather than this common LSP wiring.

vim.lsp.config("clangd", {
  before_init = require("clangd").before_init,
})

-- Enable LSP for each language
for _, lang in ipairs(require('languages')) do
  vim.lsp.enable(lang.lsp)
end
