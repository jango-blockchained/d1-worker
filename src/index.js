/**
 * D1 Worker for Grid Trading Database Operations
 */

export default {
    async fetch(request, env, ctx) {
        try {
            // Verify internal service key
            const authHeader = request.headers.get('Authorization');
            if (authHeader !== `Bearer ${env.INTERNAL_SERVICE_KEY}`) {
                return new Response('Unauthorized', { status: 401 });
            }

            const url = new URL(request.url);
            const path = url.pathname;

            // Route handling
            switch (path) {
                case '/query':
                    if (request.method !== 'POST') {
                        return new Response('Method not allowed', { status: 405 });
                    }
                    const { query, params } = await request.json();
                    const result = await env.DB.prepare(query).bind(...(params || [])).all();
                    return new Response(JSON.stringify(result), {
                        headers: { 'Content-Type': 'application/json' }
                    });

                case '/batch':
                    if (request.method !== 'POST') {
                        return new Response('Method not allowed', { status: 405 });
                    }
                    const { statements } = await request.json();
                    const batch = env.DB.batch(statements.map(({ query, params }) =>
                        env.DB.prepare(query).bind(...(params || []))
                    ));
                    const batchResult = await batch.run();
                    return new Response(JSON.stringify(batchResult), {
                        headers: { 'Content-Type': 'application/json' }
                    });

                default:
                    return new Response('Not found', { status: 404 });
            }
        } catch (error) {
            console.error('Error:', error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
}; 