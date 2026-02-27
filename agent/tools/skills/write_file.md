# write_file

Purpose: create or update a text file.

Inputs:
- path: file to write.
- content: UTF-8 text.
- append: when true, append instead of overwrite.
- createDirs: when true, create parent directories.

Notes:
- Prefer overwrite unless appending logs.
- Returns bytesWritten.
