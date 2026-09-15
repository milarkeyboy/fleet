local M = {}

local snacks_picker = require("snacks").picker
local nvim_tree_api = require("nvim-tree.api")

M.snacks_picker_win = {
  input = {
    keys = {
      ["<C-j>"] = { "list_down", mode = { "i", "n" } },
      ["<C-k>"] = { "list_up", mode = { "i", "n" } },
      ["<Esc>"] = { "close", mode = { "i", "n" } },
    },
  },
}

function M.setup()
  vim.keymap.set("n", "<leader>e", nvim_tree_api.tree.toggle, { desc = "Explorer" })

  -- Picker views
  -- I've found this to be snappier than telescope
  vim.keymap.set("n", "<leader>f", function() snacks_picker.files({ hidden = true }) end, { desc = "Find files" })
  vim.keymap.set("n", "<leader>g", snacks_picker.grep, { desc = "Grep" })
  vim.keymap.set("n", "<leader>s", snacks_picker.lsp_symbols, { desc = "Symbols (buffer)" })
  vim.keymap.set("n", "<leader>S", snacks_picker.lsp_workspace_symbols, { desc = "Symbols (workspace)" })
  vim.keymap.set("n", "<leader>b", snacks_picker.buffers, { desc = "Buffers" })
  vim.keymap.set("n", "<leader>d", snacks_picker.diagnostics_buffer, { desc = "Diagnostics (buffer)" })
  vim.keymap.set("n", "<leader>D", snacks_picker.diagnostics, { desc = "Diagnostics (workspace)" })
  vim.keymap.set("n", "gr", snacks_picker.lsp_references, { desc = "Find references" })

  -- Configure completion and buffer-local keybindings when an LSP attaches.
  local group = vim.api.nvim_create_augroup("my.lsp.keymaps", { clear = true })
  vim.api.nvim_create_autocmd("LspAttach", {
    group = group,
    callback = function(event)
      local function map(lhs, rhs, desc)
        vim.keymap.set("n", lhs, rhs, {
          buffer = event.buf,
          desc = desc,
        })
      end

      -- Configure autocomplete provided that the LSP client supports it.
      local client = assert(vim.lsp.get_client_by_id(event.data.client_id))
      if client:supports_method("textDocument/completion") then
        -- Enable completion
        vim.lsp.completion.enable(true, client.id, event.buf, {
          autotrigger = true,
        })
        -- Add a keymap for manually triggering it, since the built-in LSP
        -- support won't trigger on regular characters (only special ones). If
        -- I want to change that, I'll need another plugin (sigh).
        vim.keymap.set("i", "<C-Space>", vim.lsp.completion.get, {
          buffer = event.buf,
          desc = "Trigger completion",
        })
      end

      map("gd", vim.lsp.buf.definition, "Go to definition")
      map("gD", vim.lsp.buf.declaration, "Go to declaration")
      map("gi", vim.lsp.buf.implementation, "Go to implementation")
      map("K", vim.lsp.buf.hover, "Hover documentation")
      map("gl", function()
        vim.diagnostic.open_float({
          scope = "cursor",
          focus = false,
          border = "rounded",
        })
      end, "Show diagnostic")
      map("<leader>r", vim.lsp.buf.rename, "Rename symbol")
      map("<leader>c", vim.lsp.buf.code_action, "Code action")
    end,
  })
end

return M
