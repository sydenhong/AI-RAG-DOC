import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()

    const question = body.question || body.prompt || body.message || ''
    const chatHistory = body.chat_history || body.chatHistory || []
    const userId = body.userId || body.user_id || null

    if (!question || String(question).trim().length === 0) {
      throw new Error("Missing 'question' in request body.")
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const apiKey = Deno.env.get('GEMINI_API_KEY')

    if (!supabaseUrl || !supabaseKey || !apiKey) {
      throw new Error('Server configuration missing')
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    const cleanQuestion = String(question)
      .replace(/@ben/gi, '')
      .trim()

    if (!cleanQuestion) {
      throw new Error('Question is empty after removing @ben.')
    }

    // 1. Save user message if userId exists
    let userMessageId: string | null = null

    if (userId) {
      const { data: userMessage, error: userMessageError } = await supabase
        .from('chat_messages')
        .insert({
          user_id: userId,
          role: 'user',
          content: cleanQuestion,
        })
        .select('id')
        .single()

      if (userMessageError) {
        throw userMessageError
      }

      userMessageId = userMessage.id
    }

    // 2. Embed the user's question
    const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`

    const embedRes = await fetch(embedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: {
          parts: [
            {
              text: cleanQuestion,
            },
          ],
        },
        outputDimensionality: 768,
      }),
    })

    if (!embedRes.ok) {
      const errText = await embedRes.text()
      throw new Error(`Embedding API Error: ${errText}`)
    }

    const embedData = await embedRes.json()
    const queryEmbedding = embedData?.embedding?.values

    if (!Array.isArray(queryEmbedding)) {
      throw new Error('Embedding API returned unexpected format.')
    }

    // 3. Search trained RAG documents
    const { data: matchedDocs, error: matchError } = await supabase.rpc(
      'match_doc_segments',
      {
        query_embedding: queryEmbedding,
        match_threshold: 0.65,
        match_count: 5,
      },
    )

    if (matchError) {
      throw matchError
    }

    let contextText =
      'No specific document context found. Answer based on general knowledge.'

    if (matchedDocs && matchedDocs.length > 0) {
      contextText = matchedDocs
        .map((doc: any) => {
          return `Document: ${doc.document_title || 'Untitled'}\nCategory: ${doc.category || 'General'}\nContent: ${doc.content}`
        })
        .join('\n\n---\n\n')
    }

    // 4. Convert chat history to text
    const historyText = Array.isArray(chatHistory)
      ? chatHistory
          .slice(-10)
          .map((msg: any) => {
            const role = msg.role || 'user'
            const content = msg.content || ''
            return `${role}: ${content}`
          })
          .join('\n')
      : ''

    const systemInstruction = `
You are BEN AI, a helpful AI assistant for the E-KHMER system.

Use the provided Document Context when it is relevant.

If the answer is not found in the uploaded documents, say:
"I cannot find this information in the uploaded documents."

Then you may answer using general knowledge if helpful.

Format your response clearly using Markdown.
`

    const finalPrompt = `
Document Context:
${contextText}

Recent Chat History:
${historyText}

User Question:
${cleanQuestion}
`

    // 5. Generate answer
    const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`

    const generateRes = await fetch(generateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: systemInstruction,
            },
          ],
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: finalPrompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.3,
        },
      }),
    })

    if (!generateRes.ok) {
      const errorText = await generateRes.text()

      throw new Error(
        `Gemini API Error (${generateRes.status}): ${errorText}`,
      )
    }

    const generateData = await generateRes.json()

    const aiAnswer =
      generateData?.candidates?.[0]?.content?.parts?.[0]?.text ?? null

    if (!aiAnswer) {
      throw new Error(
        'Gemini returned an empty response. The prompt might have triggered a safety filter.',
      )
    }

    // 6. Save assistant message if userId exists
    let assistantMessageId: string | null = null

    if (userId) {
      const { data: assistantMessage, error: assistantMessageError } =
        await supabase
          .from('chat_messages')
          .insert({
            user_id: userId,
            role: 'assistant',
            content: aiAnswer,
            reply_to_message_id: userMessageId,
          })
          .select('id')
          .single()

      if (assistantMessageError) {
        throw assistantMessageError
      }

      assistantMessageId = assistantMessage.id
    }

    return new Response(
      JSON.stringify({
        status: 'success',
        answer: aiAnswer,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        matched_documents: matchedDocs || [],
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      },
    )
  } catch (error: any) {
    console.error('BEN AI Assistant Error:', error)

    return new Response(
      JSON.stringify({
        error: error?.message || String(error),
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      },
    )
  }
})
