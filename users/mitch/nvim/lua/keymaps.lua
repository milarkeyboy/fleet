local M = {}

local telescope_actions = require("telescope.actions")
local telescope_builtin = require("telescope.builtin")
local nvim_tree_api = require("nvim-tree.api")

M.telescope = {
  i = {
    -- use Ctrl to navigate up and down in insert mode.
    ["<C-j>"] = telescope_actions.move_selection_next,
    ["<C-k>"] = telescope_actions.move_selection_previous,
    ["<esc>"] = telescope_actions.close,
  },
}

function M.setup()
  vim.keymap.set("n", "<leader>e", nvim_tree_api.tree.toggle, { desc = "Explorer" })

  -- Telescope views
  vim.keymap.set("n", "<leader>f", function() telescope_builtin.find_files({ hidden = true }) end, { desc = "Find files" })
  vim.keymap.set("n", "<leader>g", telescope_builtin.live_grep, { desc = "Grep" })
  vim.keymap.set("n", "<leader>s", telescope_builtin.lsp_document_symbols, { desc = "Symbols (buffer)" })
  vim.keymap.set("n", "<leader>S", telescope_builtin.lsp_dynamic_workspace_symbols, { desc = "Symbols (workspace)" })
  vim.keymap.set("n", "<leader>b", telescope_builtin.buffers, { desc = "Buffers" })
  -- Telescope is really slow at showing the symbol references. I might have to
  -- look at whether this can be sped up. Until then, I'll live with the
  -- standard LSP command further down this file.
  -- vim.keymap.set("n", "gr", telescope_builtin.lsp_references, { desc = "Go to references" })

  -- When an LSP is attached, we add keybindings for other LSP-related actions.
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

      map("gd", vim.lsp.buf.definition, "Go to definition")
      map("gD", vim.lsp.buf.declaration, "Go to declaration")
      map("gr", vim.lsp.buf.references, "Find references")
      map("gi", vim.lsp.buf.implementation, "Go to implementation")
      map("K", vim.lsp.buf.hover, "Hover documentation")
      map("<leader>r", vim.lsp.buf.rename, "Rename symbol")
      map("<leader>c", vim.lsp.buf.code_action, "Code action")
    end,
  })
end

return M
