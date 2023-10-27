//@ts-check
import { get_cached_cdn, save_chunks_cdn_to_db, save_json_to_cdn_as_buffer, is_valid, console_log, combineStringsWithoutOverlap } from '../../../../src/utils/omni-utils';
import { computeChunkId, computeDocumentId } from './hashers.js';
import { makeToast } from './utilities.js';

const DEFAULT_FRAGMENT_SIZE = 4096;
const DEFAULT_OVERLAP_PERCENT = 0.5;

const AVERAGE_CHARACTER_PER_WORD = 5;
const AVERAGE_WORD_PER_TOKEN = 0.75;
const EMBEDDING_BATCH_SIZE = 10; // This is the number of chunks that will be embedded in parallel

function createBatches(arr, size)
{
  const batches = [];
  for (let i = 0; i < arr.length; i += size)
  {
    const start_index = i;
    const end_index = Math.min(i + size, arr.length);
    const batch = arr.slice(start_index, end_index);
    batches.push(batch);
  }
  return batches;
};

// Function to group splitted_texts into batches of EMBEDDING_BATCH_SIZE
async function breakTextIntoBatches(text, splitter)
{
  const splitted_texts = await splitter.splitText(text);
  const textBatches = createBatches(splitted_texts, EMBEDDING_BATCH_SIZE);
  return textBatches;
}
function computeCharacterToTokenRatio(chunks)
{
  let total_token_count = 0;
  let total_character_count = 0;

  let index = 0;
  for (const chunk of chunks)
  {
    if (index != chunks.length - 1) 
    {
      if (chunk) 
      {
        if (chunk.token_count) total_token_count += chunk.token_count;
        if (chunk.text) total_character_count += chunk.text.length;
      }
    }
    index += 1;
  }

  let ratio = -1;
  if (total_character_count != 0) ratio = total_character_count/total_token_count;

  return ratio;
}

async function processChunk(ctx, chunk_text, index, document_id, hasher, embedder, tokenCounterFunction, total_count)
{
  const nb_of_chars = chunk_text.length;

  if (nb_of_chars > 0)
  {
    const chunk_id = computeChunkId(ctx, chunk_text, hasher);
    await embedder.embedQuery(chunk_text); // No need to save it as the embedder is automatically caching the embedding of each chunk in the DB
    const chunk_token_count = tokenCounterFunction(chunk_text);
    const chunk_json = { source: document_id, index: index, id: chunk_id, token_count: chunk_token_count, text: chunk_text };
    makeToast(ctx, `Created document fragment ${index + 1}/${total_count}`);
    return chunk_json;
  }
}


async function computeChunks(ctx, document_id, textBatches, hasher, embedder, tokenCounterFunction)
{

  const chunks = [];
  let total_count = 0;
  for (const textBatch of textBatches)
  {
    total_count += textBatch.length;
  }

  for (const textBatch of textBatches)
  {

    const embeddingPromises = [];
    for (let chunk_index = 0; chunk_index < textBatch.length; chunk_index++) 
    {
      const chunk_text = textBatch[chunk_index];
      const embedPromise = processChunk(ctx, chunk_text, chunk_index, document_id, hasher, embedder, tokenCounterFunction, total_count);
      embeddingPromises.push(embedPromise);
    }

    const batchResults = await Promise.all(embeddingPromises);
    chunks.push(...batchResults);
  }

  if (is_valid(chunks) === false)
  {
    throw new Error(`ERROR could not chunk the documents`);
  }

  return chunks;
}

async function uploadTextWithCaching(ctx, text, hasher, chunk_size, chunk_overlap, overwrite)
{
  const text_id = computeDocumentId(ctx, [text], hasher, chunk_size, chunk_overlap);
  let text_cdn = await get_cached_cdn(ctx, text_id, overwrite);
  if (!is_valid(text_cdn))
  {
    const buffer = Buffer.from(text);
    text_cdn = await ctx.app.cdn.putTemp(buffer, { mimeType: 'text/plain; charset=utf-8', userId: ctx.userId });
    //if (!text_cdn) throw new Error(`ERROR: could not upload Text to CDN`);
    //await save_chunks_cdn_to_db(ctx, text_cdn, text_id);
  }
  else
  {
    console_log(`[ingestText] Found text_cdn: ${JSON.stringify(text_cdn)} in the DB under id: ${text_id}. Skipping uploading to CDN...`);
  }

  return text_cdn;
}

async function chunkText(ctx, document_id, document_text, hasher, embedder, splitter, tokenCounterFunction)
{
  const text_batches = await breakTextIntoBatches(document_text, splitter);
  const document_chunks = await computeChunks(ctx, document_id, text_batches, hasher, embedder, tokenCounterFunction);
  return document_chunks;
}

async function saveIndexedDocument(ctx, document_id, chunks, chunk_size, chunk_overlap, token_to_chunking_size_ratio, splitter_model)
{

  const indexed_document_info = { id: document_id, splitter_model: splitter_model, chunks: chunks, chunk_size, chunk_overlap, token_to_chunking_size_ratio };
  const indexed_document_cdn = await save_json_to_cdn_as_buffer(ctx, indexed_document_info);
  if (!indexed_document_cdn) throw new Error(`ERROR: could not save document_cdn to cdn`);

  const success = await save_chunks_cdn_to_db(ctx, indexed_document_cdn, document_id);
  if (success == false) throw new Error(`ERROR: could not save document_cdn to db`);
  return indexed_document_cdn;

}


async function createChunkBlocks(ctx, max_size, all_chunks, info)
{
  let total_token_cost = 0;
  let combined_text = "";
  const blocks = [];
  let chunk_index = 0;
  for (const chunk of all_chunks)
  {
    const is_last_index = (chunk_index == all_chunks.length - 1);

    const chunk_text = chunk?.text;
    const chunk_id = chunk?.id;

    const token_cost = chunk.token_count;
    const can_fit = (total_token_cost + token_cost <= max_size);

    if (can_fit)
    {
      combined_text = combineStringsWithoutOverlap(combined_text, chunk_text);
      total_token_cost += token_cost; // TBD: this is not accurate because we are not counting the tokens in the overlap or the instructions
      info += `Combining chunks.  chunk_id: ${chunk_id}, Token cost: ${total_token_cost}.  \n|`;
    }
    else
    {
      blocks.push({ text: combined_text, token_cost: total_token_cost });
      combined_text = chunk_text;
      total_token_cost = token_cost;
    }

    if (is_last_index)
    {
      blocks.push({ text: combined_text, token_cost: total_token_cost });
    }

    chunk_index += 1;
  }

  makeToast(ctx, `Processing ${blocks.length} blocks`);

  return { blocks, info };
}



export { chunkText, uploadTextWithCaching, saveIndexedDocument, computeCharacterToTokenRatio, createChunkBlocks };
export { DEFAULT_FRAGMENT_SIZE, DEFAULT_OVERLAP_PERCENT };
export { AVERAGE_CHARACTER_PER_WORD, AVERAGE_WORD_PER_TOKEN };