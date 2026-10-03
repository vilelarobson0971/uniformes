export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json;charset=UTF-8'
  };

  if (method === 'OPTIONS') return new Response(null, { headers });

  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Binding DB não encontrado' }), { status: 500, headers });
  }

  // 1. Status da conexão
  if (path === '/api/status' || path === '/api') {
    const stats = await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM uniformes) as total_uniformes, (SELECT COUNT(*) FROM movimentacoes) as total_movimentacoes'
    ).first();
    return new Response(JSON.stringify({ status: 'ok', stats }), { headers });
  }

  // 2. Listar uniformes do banco
  if (path === '/api/uniformes' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM uniformes ORDER BY categoria, nome, tamanho').all();
    return new Response(JSON.stringify(results || []), { headers });
  }

  // 3. Salvar alterações de uniforme (incluindo estoque mínimo)
  if (path === '/api/uniformes' && method === 'POST') {
    const data = await request.json();
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO uniformes (id, nome, tamanho, categoria, quantidade, estoque_minimo, unidade, localizacao, observacoes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id) DO UPDATE SET
         nome = excluded.nome,
         tamanho = excluded.tamanho,
         categoria = excluded.categoria,
         quantidade = excluded.quantidade,
         estoque_minimo = excluded.estoque_minimo,
         unidade = excluded.unidade,
         localizacao = excluded.localizacao,
         observacoes = excluded.observacoes,
         updated_at = excluded.updated_at`
    ).bind(
      data.id,
      data.nome || data.name,
      data.tamanho || data.size,
      data.categoria || data.category,
      data.quantidade !== undefined ? data.quantidade : 0,
      data.estoque_minimo !== undefined ? data.estoque_minimo : 1,
      data.unidade || 'peça',
      data.localizacao || null,
      data.observacoes || null,
      now,
      now
    ).run();

    return new Response(JSON.stringify({ success: true, message: 'Uniforme e estoque mínimo salvos no D1' }), { headers });
  }

  // 4. Listar histórico de movimentações
  if (path === '/api/movimentacoes' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM movimentacoes ORDER BY data_hora DESC LIMIT 200').all();
    return new Response(JSON.stringify(results || []), { headers });
  }

  // 5. Gravar retirada ou entrada no banco D1 em tempo real
  if (path === '/api/movimentacoes' && method === 'POST') {
    const data = await request.json();
    const now = new Date().toISOString();

    const item = await env.DB.prepare('SELECT * FROM uniformes WHERE id = ?').bind(data.uniforme_id).first();
    if (!item) return new Response(JSON.stringify({ error: 'Uniforme não encontrado' }), { status: 404, headers });

    const prevStock = item.quantidade;
    const newStock = data.tipo === 'SAIDA' ? prevStock - data.quantidade : prevStock + data.quantidade;

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO movimentacoes (id, uniforme_id, nome_uniforme, tamanho_uniforme, categoria, tipo, quantidade, funcionario_recebeu, funcionario_entregou, data_hora, motivo, documento_ref, saldo_anterior, saldo_novo, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)'
      ).bind(
        data.id || 'mov-' + Date.now(),
        data.uniforme_id,
        item.nome,
        item.tamanho,
        item.categoria,
        data.tipo,
        data.quantidade,
        data.funcionario_recebeu,
        data.funcionario_entregou,
        data.data_hora || now,
        data.motivo,
        data.documento_ref || null,
        prevStock,
        newStock,
        now
      ),
      env.DB.prepare('UPDATE uniformes SET quantidade = ?, updated_at = ? WHERE id = ?').bind(newStock, now, data.uniforme_id)
    ]);

    return new Response(JSON.stringify({ success: true, newStock }), { headers });
  }

  // 6. Limpar histórico de movimentações
  if (path === '/api/movimentacoes/limpar' && method === 'POST') {
    await env.DB.prepare('DELETE FROM movimentacoes').run();
    return new Response(JSON.stringify({ success: true, message: 'Histórico limpo com sucesso' }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Rota não encontrada' }), { status: 404, headers });
}
