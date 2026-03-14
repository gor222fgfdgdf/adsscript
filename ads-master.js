/**
 * Google Ads Master Script (v15.2 - Remote hosted, no domain check, fixed email)
 */

function runMain(ACCOUNT_CONFIG) {

  var CONFIG = {
    SUPABASE_URL: 'https://bdnppvkjpknwjlhhaarw.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',

    TABLE_ACCOUNTS:   'account_registry',
    TABLE_ADS:        'display_ads_registry',
    TABLE_PLACEMENTS: 'placement_stats',

    TG_TOKEN:   '5203374800:AAGZ6T72DxmjVnqbza92O0y2SJyk2lw0Pr4',
    TG_CHAT_ID: 37742949,

    SAFETY_LIMIT:            (ACCOUNT_CONFIG && ACCOUNT_CONFIG.SAFETY_LIMIT            != null) ? ACCOUNT_CONFIG.SAFETY_LIMIT            : 45,
    EXTRA_LIMIT:             (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EXTRA_LIMIT             != null) ? ACCOUNT_CONFIG.EXTRA_LIMIT             : 0,
    PLACEMENT_SYNC_HOUR_UTC: (ACCOUNT_CONFIG && ACCOUNT_CONFIG.PLACEMENT_SYNC_HOUR_UTC != null) ? ACCOUNT_CONFIG.PLACEMENT_SYNC_HOUR_UTC : 10
  };

  Logger.log('[CONFIG] SAFETY_LIMIT=' + CONFIG.SAFETY_LIMIT + ' EXTRA_LIMIT=' + CONFIG.EXTRA_LIMIT);

  /* ====================== MAIN ====================== */

  var acc  = AdsApp.currentAccount();
  var myId = acc.getCustomerId();

  logDivider_('START');

  try { checkSafetyLimitsStrict_(acc, CONFIG); }  catch (e) { Logger.log('[ERR][SAFETY] ' + e); }
  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e); }
  try { syncAdEditsFromRegistry_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][AD_EDITS] ' + e); }

  updateAccountRegistry_(acc, CONFIG);
  syncAdsToRegistry_(myId, CONFIG);

  try { maybeSyncPlacementStats_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][PLACEMENTS] ' + e); }

  logDivider_('END');

  /* ====================== PLACEMENT ====================== */

  function maybeSyncPlacementStats_(myId, CONFIG) {
    var currentHourUTC = new Date().getUTCHours();
    var yesterday      = getYesterdayDate_();

    if (currentHourUTC !== CONFIG.PLACEMENT_SYNC_HOUR_UTC) {
      Logger.log('[PLACEMENTS] Skip — not sync hour (now=' + currentHourUTC + ' UTC, expected=' + CONFIG.PLACEMENT_SYNC_HOUR_UTC + ')');
      return;
    }

    var check = apiCall_('get',
      '/rest/v1/' + CONFIG.TABLE_PLACEMENTS +
      '?account_id=eq.' + myId +
      '&date=eq.'       + yesterday +
      '&limit=1',
      null, null, CONFIG
    );

    if (check && check.length > 0) {
      Logger.log('[PLACEMENTS] Skip — already synced for ' + yesterday);
      return;
    }

    syncPlacementStats_(myId, CONFIG);
  }

  function syncPlacementStats_(myId, CONFIG) {
    var yesterday = getYesterdayDate_();
    Logger.log('[PLACEMENTS] Fetching for: ' + yesterday);

    var gaql =
      'SELECT ' +
      '  detail_placement_view.display_name, ' +
      '  detail_placement_view.placement, ' +
      '  detail_placement_view.placement_type, ' +
      '  campaign.name, ' +
      '  ad_group.name, ' +
      '  metrics.impressions, ' +
      '  metrics.clicks, ' +
      '  metrics.cost_micros, ' +
      '  metrics.conversions ' +
      'FROM detail_placement_view ' +
      'WHERE segments.date = \'' + yesterday + '\' ' +
      'AND metrics.impressions > 0';

    var rows  = AdsApp.search(gaql);
    var batch = [];
    var total = 0;

    while (rows.hasNext()) {
      var row           = rows.next();
      var dpv           = row.detailPlacementView || {};
      var placement     = dpv.placement      || '';
      var displayName   = dpv.displayName    || placement;
      var placementType = dpv.placementType  || '';
      var campaignName  = (row.campaign && row.campaign.name) || '';
      var adGroupName   = (row.adGroup  && row.adGroup.name)  || '';
      var impressions   = parseInt((row.metrics && row.metrics.impressions) || 0, 10);
      var clicks        = parseInt((row.metrics && row.metrics.clicks)      || 0, 10);
      var costMicros    = parseInt((row.metrics && row.metrics.costMicros)  || 0, 10);
      var conversions   = parseFloat((row.metrics && row.metrics.conversions) || 0);

      batch.push({
        account_id:     myId,
        placement:      placement,
        display_name:   displayName,
        placement_type: placementType,
        campaign_name:  campaignName,
        ad_group_name:  adGroupName,
        date:           yesterday,
        impressions:    impressions,
        clicks:         clicks,
        cost:           costMicros / 1000000,
        conversions:    conversions,
        updated_at:     new Date().toISOString()
      });

      total++;

      if (batch.length >= 50) {
        apiCall_('post', '/rest/v1/' + CONFIG.TABLE_PLACEMENTS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
        batch = [];
        Logger.log('[PLACEMENTS] Batch sent: 50 rows');
      }
    }

    if (batch.length > 0) {
      apiCall_('post', '/rest/v1/' + CONFIG.TABLE_PLACEMENTS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
      Logger.log('[PLACEMENTS] Batch sent: ' + batch.length + ' rows');
    }

    Logger.log('[PLACEMENTS] Done. Total synced: ' + total);
  }

  /* ====================== УПРАВЛЕНИЕ СТАТУСАМИ И URL ====================== */

  function syncAdEditsFromRegistry_(myId, CONFIG) {
    var edits = apiCall_('get',
      '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + myId + '&needs_sync=eq.true',
      null, null, CONFIG
    );

    if (!edits || edits.length === 0) return;
    Logger.log('[SYNC] Правок найдено: ' + edits.length);

    edits.forEach(function(edit) {
      var adIterator = AdsApp.ads().withIds([edit.ad_id]).get();
      if (!adIterator.hasNext()) return;

      var ad = adIterator.next();

      if (edit.target_status === 'ENABLED') { ad.enable(); Logger.log('[STATUS] Ad ' + edit.ad_id + ' -> ENABLED'); }
      if (edit.target_status === 'PAUSED')  { ad.pause();  Logger.log('[STATUS] Ad ' + edit.ad_id + ' -> PAUSED'); }

      if (edit.edit_final_url) {
        ad.urls().setFinalUrl(edit.edit_final_url);
        Logger.log('[URL] Ad ' + edit.ad_id + ' -> ' + edit.edit_final_url);
      }

      patchSupabase_(CONFIG.TABLE_ADS, {
        needs_sync:     false,
        edit_final_url: null,
        target_status:  null
      }, 'ad_id=eq.' + edit.ad_id, CONFIG);
    });
  }

  /* ====================== СТРОГАЯ БЕЗОПАСНОСТЬ ====================== */

  function checkSafetyLimitsStrict_(acc, CONFIG) {
    var todayCost  = acc.getStatsFor('TODAY').getCost();
    var totalLimit = CONFIG.SAFETY_LIMIT + CONFIG.EXTRA_LIMIT;
    var balance    = 0;

    try {
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    if (todayCost >= totalLimit || balance <= -totalLimit) {
      var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').get();
      while (campaigns.hasNext()) {
        var camp = campaigns.next();
        var ads  = camp.ads().get();
        while (ads.hasNext()) { ads.next().remove(); }
        camp.pause();
      }
      tgSend_('🛑 <b>CRITICAL STOP</b>\nAcc: ' + acc.getCustomerId() + '\nAds DELETED (' + totalLimit + '$).', CONFIG);
    }
  }

  /* ====================== РЕЕСТРЫ ====================== */

  function updateAccountRegistry_(acc, CONFIG) {
    var activeBid = 0;
    var balance   = 0;
    try {
      var ag = AdsApp.adGroups().withCondition('Status = ENABLED').withLimit(1).get();
      if (ag.hasNext()) activeBid = ag.next().bidding().getCpc();
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS, {
      uid:         acc.getCustomerId(),
      name:        acc.getName(),
      email:       detectAccountEmail_(),
      today_cost:  acc.getStatsFor('TODAY').getCost(),
      all_cost:    acc.getStatsFor('ALL_TIME').getCost(),
      current_cpc: activeBid,
      balance:     balance,
      updated_at:  new Date().toISOSt
