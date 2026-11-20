import {projectOperation} from './pi-documents.mjs';

export default function projectTools(pi) {
  const root = process.env.OFFICE_PROJECT_ROOT;
  const identity = process.env.OFFICE_PROJECT_IDENTITY;
  const journal = process.env.OFFICE_PROJECT_JOURNAL;
  if (!root || !journal) throw new Error('缺少项目工作目录。');
  pi.registerTool({
    name: 'office_project',
    label: '项目文件',
    description:
      'Inspect and edit UTF-8 project files. list lists a directory; search finds literal query inside a directory; read returns text (optional startLine). write creates a new file with text. edit replaces a unique exact oldText with newText in an existing file. All paths are relative to the selected project.',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: {
        operation: {type: 'string', enum: ['list', 'search', 'read', 'write', 'edit']},
        path: {type: 'string'},
        query: {type: 'string'},
        text: {type: 'string'},
        oldText: {type: 'string'},
        newText: {type: 'string'},
        startLine: {type: 'integer', minimum: 1}
      },
      required: ['operation'],
      additionalProperties: false
    },
    async execute(_id, args, signal) {
      const result = await projectOperation({...args, root, journal, identity}, {signal});
      return {content: [{type: 'text', text: JSON.stringify(result)}], details: {}};
    }
  });
}
