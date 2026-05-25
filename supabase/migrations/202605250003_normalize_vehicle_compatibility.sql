create or replace function public.normalize_vehicle_brand_text(input_value text)
returns text
language plpgsql
immutable
as $$
declare
  cleaned text;
  comparable text;
begin
  if input_value is null then
    return null;
  end if;

  cleaned := regexp_replace(btrim(input_value), '\s+', ' ', 'g');
  if cleaned = '' then
    return null;
  end if;

  comparable := lower(cleaned);

  case comparable
    when 'bmw' then return 'BMW';
    when 'gmc' then return 'GMC';
    when 'byd' then return 'BYD';
    when 'mg' then return 'MG';
    when 'ram' then return 'RAM';
    else return initcap(lower(cleaned));
  end case;
end;
$$;

create or replace function public.normalize_vehicle_model_token(input_value text)
returns text
language plpgsql
immutable
as $$
declare
  cleaned text;
  comparable text;
begin
  cleaned := btrim(coalesce(input_value, ''));
  if cleaned = '' then
    return cleaned;
  end if;

  comparable := lower(cleaned);

  case comparable
    when 'cr-v' then return 'CR-V';
    when 'hr-v' then return 'HR-V';
    when 'cx-5' then return 'CX-5';
    when 'cx-30' then return 'CX-30';
    when 'rav4' then return 'RAV4';
    when 'np300' then return 'NP300';
    when 'bt-50' then return 'BT-50';
    when 'f-150' then return 'F-150';
    else
      if cleaned ~* '^[a-z]+[0-9][a-z0-9]*$' then
        return upper(regexp_replace(cleaned, '^([[:alpha:]]+)([[:alnum:]]*)$', '\1')) ||
          upper(regexp_replace(cleaned, '^[[:alpha:]]+', ''));
      end if;

      return upper(substr(comparable, 1, 1)) || substr(comparable, 2);
  end case;
end;
$$;

create or replace function public.normalize_vehicle_model_text(input_value text)
returns text
language plpgsql
immutable
as $$
declare
  cleaned text;
  comparable text;
  word text;
  part text;
  formatted_words text[] := '{}';
  formatted_parts text[];
begin
  if input_value is null then
    return null;
  end if;

  cleaned := regexp_replace(btrim(input_value), '\s+', ' ', 'g');
  if cleaned = '' then
    return null;
  end if;

  comparable := lower(cleaned);

  case comparable
    when 'cr-v' then return 'CR-V';
    when 'hr-v' then return 'HR-V';
    when 'cx-5' then return 'CX-5';
    when 'cx-30' then return 'CX-30';
    when 'rav4' then return 'RAV4';
    when 'np300' then return 'NP300';
    when 'bt-50' then return 'BT-50';
    when 'f-150' then return 'F-150';
    else
      foreach word in array string_to_array(cleaned, ' ')
      loop
        formatted_parts := '{}';
        foreach part in array string_to_array(word, '-')
        loop
          formatted_parts := array_append(formatted_parts, public.normalize_vehicle_model_token(part));
        end loop;
        formatted_words := array_append(formatted_words, array_to_string(formatted_parts, '-'));
      end loop;

      return array_to_string(formatted_words, ' ');
  end case;
end;
$$;

update public.products
set vehicle_brand = public.normalize_vehicle_brand_text(vehicle_brand)
where vehicle_brand is not null
  and vehicle_brand is distinct from public.normalize_vehicle_brand_text(vehicle_brand);

update public.products
set vehicle_model = public.normalize_vehicle_model_text(vehicle_model)
where vehicle_model is not null
  and vehicle_model is distinct from public.normalize_vehicle_model_text(vehicle_model);
