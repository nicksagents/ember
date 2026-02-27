# list_dir

Purpose: list files/directories at a path.

Inputs:
- path: directory to list.
- recursive: when true, walk nested directories.
- maxDepth: limits recursion depth when recursive.
- includeHidden: include dotfiles when true.

Notes:
- Prefer shallow listings unless you need a full tree.
- Use `maxDepth` to avoid huge outputs.
