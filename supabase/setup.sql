-- AI Chat app: vector store for document embeddings (Project 4)
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run

-- 1. Turn on the pgvector extension
create extension if not exists vector with schema extensions;

-- 2. One row per document chunk, with its embedding (512 numbers)
create table if not exists public.document_chunks (
  id bigint generated always as identity primary key,
  document_url text not null,
  document_name text not null,
  chunk_index integer not null,
  content text not null,
  embedding extensions.vector(512) not null,
  created_at timestamptz not null default now()
);

-- Each search only looks at the documents of one chat, so we index by document
create index if not exists document_chunks_document_url_idx on public.document_chunks (document_url);

-- 3. Security: no public access. Only the server (secret key) can read and write.
alter table public.document_chunks enable row level security;

-- 4. Hybrid search: meaning (vector similarity) + exact words (full-text search)
--    Vectors find passages with the same meaning; keywords rescue short facts hidden in long passages.
drop function if exists public.match_document_chunks(extensions.vector, text[], integer);

create or replace function public.match_document_chunks(
  query_embedding extensions.vector(512),
  query_text text,
  document_urls text[],
  match_count integer default 8
)
returns table (
  document_url text,
  document_name text,
  chunk_index integer,
  content text,
  similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with chunks as (
    select
      c.document_url,
      c.document_name,
      c.chunk_index,
      c.content,
      1 - (c.embedding <=> query_embedding) as vector_score,
      tsvector_to_array(to_tsvector('english', c.content)) as words
    from public.document_chunks c
    where c.document_url = any (document_urls)
  ),
  terms as (
    -- the question's words, simplified ("replaced" -> "replac"), common words like "the" removed
    select distinct unnest(tsvector_to_array(to_tsvector('english', query_text))) as term
  ),
  weights as (
    -- rare words (e.g. "hotline") count more than words found everywhere (e.g. "policy")
    select
      t.term,
      greatest(ln((select count(*) from chunks)::float / (1 + count(c.chunk_index))) + 1, 0) as weight
    from terms t
    left join chunks c on c.words @> array[t.term]
    group by t.term
  ),
  scored as (
    select
      c.*,
      coalesce((select sum(w.weight) from weights w where c.words @> array[w.term]), 0) as keyword_score
    from chunks c
  ),
  combined as (
    -- 70% meaning + 30% keywords (keyword scores scaled so the best match = 1)
    select
      document_url,
      document_name,
      chunk_index,
      content,
      0.7 * vector_score
        + 0.3 * coalesce(keyword_score / nullif(max(keyword_score) over (), 0), 0) as similarity
    from scored
  )
  select document_url, document_name, chunk_index, content, similarity
  from combined
  order by similarity desc
  limit match_count;
$$;

revoke execute on function public.match_document_chunks from public, anon, authenticated;
grant execute on function public.match_document_chunks to service_role;
