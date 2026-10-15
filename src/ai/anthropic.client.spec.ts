import { extractJson } from './anthropic.client';

describe('ler JSON das respostas da IA', () => {
  it('com e sem bloco ```json, com texto à volta', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Aqui está: {"total": 12.5, "items": [{"n": "x}"}]} obrigado')).toEqual({ total: 12.5, items: [{ n: 'x}' }] });
    expect(extractJson('sem json')).toBeNull();
    expect(extractJson('{"partido": ')).toBeNull();
  });
});
