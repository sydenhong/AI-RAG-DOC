import { createClient } from 'npm:@supabase/supabase-js@2'
import { resolvePDFJS } from 'https://esm.sh/pdfjs-serverless@0.4.2'
import mammoth from 'npm:mammoth@1.8.0'
import { Buffer } from 'node:buffer'

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

    const documentId = body.documentId || body.document_id || crypto.randomUUID()
    const title = body.title
    const description = body.description || null
    const category = body.category || 'General'
    const tags = body.tags || []

    const filePath = body.filePath || body.file_path || null
    const fileUrl = body.fileUrl || body.file_url || null
    const bucketName = body.bucketName || body.bucket_name || 'rag-documents'

    const textContent = body.textContent || body.text_content || ''
    const userId = body.userId || body.user_id || null

    if (!title || String(title).trim().length === 0) {
      throw new Error("Missing 'title' in request body.")
    }

    if (!filePath && !textContent) {
      throw new Error("Missing 'filePath' or 'textContent' in request body.")
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const apiKey = Deno.env.get('GEMINI_API_KEY')

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not configured')
    }

    if (!apiKey) {
      throw new Error('Gemini API key not configured')
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    // 1. Check duplicate document by id
    const { data: existingDocument, error: existingDocumentError } = await supabase
      .from('documents')
      .select('id')
      .eq('id', documentId)
      .maybeSingle()

    if (existingDocumentError) {
      throw existingDocumentError
    }

    if (existingDocument) {
      return new Response(
        JSON.stringify({
          status: 'already_registered',
          document_id: existingDocument.id,
          message: 'This document already exists.',
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        },
      )
    }

    const fileType = filePath
      ? filePath.split('.').pop()?.toLowerCase() || null
      : 'text'

    // 2. Insert document metadata
    // file_path belongs to documents table, not doc_segments
    const { data: documentData, error: documentError } = await supabase
      .from('documents')
      .insert({
        id: documentId,
        title: String(title).trim(),
        description,
        category,
        tags,
        file_type: fileType,
        file_url: fileUrl,
        file_path: filePath,
        status: 'active',
        created_by: userId,
      })
      .select('id')
      .single()

    if (documentError) {
      throw documentError
    }

    let textToProcess = textContent || ''

    // 3. Download and extract file text
    if (filePath) {
      const { data: fileData, error: downloadError } = await supabase.storage
        .from(bucketName)
        .download(filePath)

      if (downloadError) {
        await supabase.from('documents').delete().eq('id', documentData.id)
        throw downloadError
      }

      if (!fileData) {
        await supabase.from('documents').delete().eq('id', documentData.id)
        throw new Error('File not found in Supabase Storage.')
      }

      const MAX_FILE_SIZE_MB = 10

      if (fileData.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        await supabase.from('documents').delete().eq('id', documentData.id)
        throw new Error(`File exceeds the maximum limit of ${MAX_FILE_SIZE_MB}MB.`)
      }

      const fileExt = filePath.toLowerCase()
      const arrayBuffer = await fileData.arrayBuffer()

      if (fileExt.endsWith('.pdf')) {
        const { getDocument } = await resolvePDFJS()
        const data = new Uint8Array(arrayBuffer)

        const doc = await getDocument({
          data,
          useSystemFonts: true,
        }).promise

        let pdfString = ''

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
          const page = await doc.getPage(pageNum)
          const content = await page.getTextContent()

          const strings = content.items
            .map((item: any) => item?.str || '')
            .filter((text: string) => text.trim().length > 0)

          pdfString += strings.join(' ') + '\n'
        }

        textToProcess = pdfString
      } else if (
        fileExt.endsWith('.txt') ||
        fileExt.endsWith('.md') ||
        fileExt.endsWith('.csv')
      ) {
        textToProcess = await fileData.text()
      } else if (fileExt.endsWith('.docx')) {
        const buffer = Buffer.from(arrayBuffer)

        const result = await mammoth.extractRawText({
          buffer,
        })

        textToProcess = result.value || ''
      } else {
        await supabase.from('documents').delete().eq('id', documentData.id)

        throw new Error(
          'Unsupported file type. Only .pdf, .docx, .md, .csv, and .txt are supported.',
        )
      }
    }

    textToProcess = String(textToProcess || '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!textToProcess || textToProcess.length === 0) {
      await supabase.from('documents').delete().eq('id', documentData.id)

      return new Response(
        JSON.stringify({
          error: 'No readable text found in this file.',
          reason:
            'This PDF may be scanned, image-based, or exported without selectable text. Please upload a text-based PDF, DOCX, TXT, CSV, MD, or paste the text manually.',
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        },
      )
    }

    // 4. Chunk text
    const chunkSize = 1000
    const overlap = 100
    const chunks: string[] = []

    let i = 0

    while (i < textToProcess.length) {
      const chunk = textToProcess.slice(i, i + chunkSize).trim()

      if (chunk.length > 0) {
        chunks.push(chunk)
      }

      i += chunkSize - overlap
    }

    if (chunks.length === 0) {
      await supabase.from('documents').delete().eq('id', documentData.id)
      throw new Error('Could not create text chunks from this document.')
    }

    // 5. Create embeddings
    const recordsToInsert: any[] = []

    for (let index = 0; index < chunks.length; index++) {
      const chunkText = chunks[index]

      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`

      const geminiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: {
            parts: [
              {
                text: chunkText,
              },
            ],
          },
          outputDimensionality: 768,
        }),
      })

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text()

        await supabase.from('documents').delete().eq('id', documentData.id)

        throw new Error(
          `Gemini API Error (${geminiResponse.status}): ${errorText}`,
        )
      }

      const responseData = await geminiResponse.json()
      const embedding = responseData?.embedding?.values

      if (!embedding || !Array.isArray(embedding)) {
        await supabase.from('documents').delete().eq('id', documentData.id)
        throw new Error('Invalid embedding response from Gemini API.')
      }

      // IMPORTANT:
      // doc_segments has no file_path.
      // Only insert fields that exist in your SQL.
      recordsToInsert.push({
        document_id: documentData.id,
        content: chunkText,
        embedding,
        chunk_index: index,
      })
    }

    // 6. Insert into doc_segments
    const { error: insertSegmentsError } = await supabase
      .from('doc_segments')
      .insert(recordsToInsert)

    if (insertSegmentsError) {
      await supabase.from('documents').delete().eq('id', documentData.id)
      throw insertSegmentsError
    }

    return new Response(
      JSON.stringify({
        status: 'success',
        document_id: documentData.id,
        chunks_processed: recordsToInsert.length,
        characters_processed: textToProcess.length,
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
    console.error('Error in register-doc-rag:', error)

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
