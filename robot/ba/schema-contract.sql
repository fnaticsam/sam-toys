-- PROPOSED CONTRACT ONLY. Not a migration; never executed by this packet or the robot.
-- Reconcile with the real flights schema before Sam approves any database change.
-- Expose flights via the Data API only after review; grant only service_role.
begin;
create schema if not exists flights;
revoke all on schema flights from public, anon, authenticated;
grant usage on schema flights to service_role;

create table flights.ba_account_snapshots (
  id uuid primary key, account_ref text not null, captured_at timestamptz not null,
  tier text not null, tier_points bigint not null check (tier_points >= 0),
  avios bigint not null check (avios >= 0), collection_year_end date not null
);
create table flights.reward_searches (
  id uuid primary key, account_ref text not null, origin text not null, destination text not null,
  departure_date date not null, cabin text not null check (cabin in ('economy','premium','business','first')),
  adults integer not null default 1 check (adults = 1), trip_type text not null default 'one_way' check (trip_type = 'one_way'),
  status text not null check (status in ('running','completed','failed')),
  requested_at timestamptz not null, completed_at timestamptz, failure_code text
);
create table flights.reward_results (
  id uuid primary key default gen_random_uuid(), search_id uuid not null references flights.reward_searches(id),
  flight_numbers jsonb not null, origin text not null, destination text not null,
  departure_date date not null, cabin text not null, departure_time text not null, arrival_time text not null,
  available_seats integer, price_basis text not null check (price_basis = 'one_adult_one_way'),
  mixes jsonb not null check (jsonb_typeof(mixes) = 'array' and jsonb_array_length(mixes) > 0)
);
-- Reserved for a later supervised booking phase; phase 6a never touches this table.
create table flights.booking_requests (
  id uuid primary key default gen_random_uuid(), account_ref text not null,
  requested_at timestamptz not null default now(), status text not null default 'pending', request jsonb not null
);
create table flights.robot_events (
  id uuid primary key, account_ref text not null, kind text not null, created_at timestamptz not null,
  details jsonb not null default '{}', otp_code text check (otp_code ~ '^\d{6,8}$'),
  otp_expires_at timestamptz, otp_consumed_at timestamptz
);
create index robot_events_account_time on flights.robot_events(account_ref, created_at);
create index reward_results_search on flights.reward_results(search_id);
alter table flights.ba_account_snapshots enable row level security;
alter table flights.reward_searches enable row level security;
alter table flights.reward_results enable row level security;
alter table flights.booking_requests enable row level security;
alter table flights.robot_events enable row level security;
revoke all on all tables in schema flights from public, anon, authenticated;
grant select, insert on flights.ba_account_snapshots, flights.reward_searches, flights.reward_results, flights.robot_events to service_role;
grant update on flights.reward_searches, flights.robot_events to service_role;
-- No service_role booking grant is added here. Never use its bypass authority to book.

create function flights.complete_robot_reward_search(p_search_id uuid, p_results jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from flights.reward_searches where id = p_search_id and status = 'running' for update;
  if not found then raise exception 'SEARCH_STATE'; end if;
  if jsonb_typeof(p_results) <> 'array' then raise exception 'RESULT_FORMAT'; end if;
  insert into flights.reward_results(search_id, flight_numbers, origin, destination, departure_date, cabin, departure_time, arrival_time, available_seats, price_basis, mixes)
  select p_search_id, x.flight_numbers, x.origin, x.destination, x.departure_date, x.cabin, x.departure_time, x.arrival_time, x.available_seats, x.price_basis, x.mixes
  from jsonb_to_recordset(p_results) as x(flight_numbers jsonb, origin text, destination text, departure_date date, cabin text, departure_time text, arrival_time text, available_seats integer, price_basis text, mixes jsonb);
  update flights.reward_searches set status = 'completed', completed_at = now() where id = p_search_id;
end $$;

create function flights.submit_robot_otp(p_account_ref text, p_request_id uuid, p_code text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_code !~ '^\d{6,8}$' then raise exception 'OTP_FORMAT'; end if;
  update flights.robot_events set otp_code = p_code
  where id = p_request_id and account_ref = p_account_ref and kind = 'otp_requested'
    and otp_consumed_at is null and otp_expires_at > now();
  if not found then raise exception 'OTP_EXPIRED'; end if;
end $$;

create function flights.consume_robot_otp(p_account_ref text, p_request_id uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare r flights.robot_events; result text;
begin
  select * into r from flights.robot_events where id = p_request_id and account_ref = p_account_ref
    and kind = 'otp_requested' for update;
  if not found or r.otp_consumed_at is not null then return null; end if;
  if r.otp_expires_at <= now() then
    update flights.robot_events set otp_code = null, otp_consumed_at = now() where id = p_request_id;
    return null;
  end if;
  if r.otp_code is null then return null; end if;
  result := r.otp_code;
  update flights.robot_events set otp_code = null, otp_consumed_at = now() where id = p_request_id;
  return result;
end $$;
revoke all on function flights.complete_robot_reward_search(uuid,jsonb), flights.submit_robot_otp(text,uuid,text), flights.consume_robot_otp(text,uuid) from public, anon, authenticated;
grant execute on function flights.complete_robot_reward_search(uuid,jsonb), flights.submit_robot_otp(text,uuid,text), flights.consume_robot_otp(text,uuid) to service_role;
commit;
