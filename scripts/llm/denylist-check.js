/**
 * Regression Test for MCP Write-Tool Denylist
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.9 & 8).
 */

const BLOCKED_VERBS = [
  'create', 'update', 'delete', 'push', 'merge', 'write', 'send',
  'add', 'edit', 'upload', 'submit', 'approve', 'reject', 'execute',
  'invoke', 'schedule_message', 'secret_scanning', 'copilot'
];

function isDisallowedTool(toolName) {
  if (!toolName) return false;

  // Blocked general verbs
  for (const verb of BLOCKED_VERBS) {
    if (toolName.toLowerCase().includes(verb)) {
      // Exceptions: comments, commit reads, pull request reads
      if (toolName.includes('comment') || toolName.includes('get_commit') || toolName.includes('pull_request_read')) {
        continue;
      }
      return true;
    }
  }

  // Anchored transition block
  if (toolName.includes('transition')) {
    return true;
  }

  // Dangerous shell / edit verbs
  const dangerousTools = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'KillShell'];
  if (dangerousTools.includes(toolName)) {
    return true;
  }

  return false;
}

function runCheck() {
  console.log('Running MCP Denylist checks...');

  // 1. Assert write tools are BLOCKED
  const writeTools = [
    'mcp__qe-mcp__github__create_pull_request',
    'mcp__qe-mcp__github__merge_branch',
    'mcp__qe-mcp__jira__create_issue',
    'mcp__qe-mcp__jira__update_issue',
    'mcp__qe-mcp__jira__transition_issue',
    'mcp__qe-mcp__slack__send_message',
    'mcp__qe-mcp__datadog__delete_monitor',
    'mcp__qe-mcp__github__push_files',
    'Bash',
    'Edit'
  ];

  for (const tool of writeTools) {
    if (!isDisallowedTool(tool)) {
      throw new Error(`SECURITY FAILURE: Tool ${tool} was expected to be BLOCKED, but was allowed!`);
    }
  }

  // 2. Assert read tools are ALLOWED
  const readTools = [
    'mcp__qe-mcp__github__get_file_contents',
    'mcp__qe-mcp__github__list_commits',
    'mcp__qe-mcp__github__get_commit',
    'mcp__qe-mcp__github__pull_request_read',
    'mcp__qe-mcp__github__search_pull_requests',
    'mcp__qe-mcp__datadog__aggregate_spans',
    'mcp__qe-mcp__datadog__search_datadog_spans',
    'mcp__qe-mcp__jira__get_issue',
    'mcp__qe-mcp__jira__search_issues'
  ];

  for (const tool of readTools) {
    if (isDisallowedTool(tool)) {
      throw new Error(`SECURITY FAILURE: Read tool ${tool} was unexpectedly BLOCKED!`);
    }
  }

  console.log('✅ All MCP denylist security checks passed successfully.');
}

if (require.main === module) {
  try {
    runCheck();
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
}

module.exports = {
  isDisallowedTool,
  runCheck
};

