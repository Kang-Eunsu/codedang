import { type Problem, Language, Level } from '@prisma/client'

export const problems: Problem[] = [
  {
    id: 1,
    createdById: 1,
    groupId: 1,
    title: 'public problem',
    description: '',
    inputDescription: '',
    outputDescription: '',
    hint: '',
    template: [
      {
        language: Language.C,
        code: [
          { id: 1, text: 'code', locked: false },
          { id: 2, text: 'unchanged', locked: true }
        ]
      }
    ],
    languages: [Language.C],
    timeLimit: 1000,
    memoryLimit: 4096,
    difficulty: Level.Level1,
    source: '',
    exposeTime: new Date(),
    createTime: undefined,
    updateTime: undefined,
    inputExamples: [],
    outputExamples: []
  }
]
