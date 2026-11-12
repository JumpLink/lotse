---
name: inbox-report
description: Summarise what changed in a folder since a given day
allowed-tools: files
metadata:
  lotsman-profile: public
  lotsman-rights: read
  lotsman-params: folder, since=yesterday
  lotsman-precheck: Is there anything new in {{folder}} since {{since}}? End with WORK or NOTHING.
---
List what changed in {{folder}} since {{since}} and summarise it in five lines.
