-- Centro de Contenido - marca Climactiva y publicaciones de imagen principal.
-- Idempotente: actualiza configuracion vigente sin alterar publicaciones ya publicadas.

update public.brand_profiles
set
  brand_name = 'Climactiva',
  description = replace(description, 'Clima Activa', 'Climactiva'),
  updated_at = now()
where brand_name in ('Clima Activa', 'ClimaActiva', 'Climactiva')
   or is_default = true;

update public.content_publications
set
  hashtags = array_replace(hashtags, 'ClimaActiva', 'Climactiva'),
  updated_at = now()
where status in ('draft','pending_approval','approved','scheduled','failed','paused')
  and 'ClimaActiva' = any(hashtags);
