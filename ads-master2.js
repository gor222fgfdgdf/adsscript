/* ====================== АВТОРЕЖИМ СТРАТЕГИИ И ДЕМОГРАФИИ ====================== */

  function autoUpgradeBiddingStrategy_(CONFIG) {
    Logger.log('[BID_UPGRADE] Проверка смарт-стратегий и демографии...');
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var upgradedCount = 0;
    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var expectedMicros = Math.round(CONFIG.TARGET_CPA * 1000000);

    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      
      // Запрашиваем через GAQL точные данные по стратегии и ставке
      var query = "SELECT campaign.bidding_strategy_type, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.id = " + camp.getId();
      var res = AdsApp.search(query);
      if (!res.hasNext()) continue;
      
      var row = res.next();
      var strategyType = row.campaign.bidding_strategy_type;
      var targetCpaMicros = (row.campaign.maximize_conversions && row.campaign.maximize_conversions.target_cpa_micros) ? parseInt(row.campaign.maximize_conversions.target_cpa_micros, 10) : 0;
      
      var isConversionStrategy = (strategyType === 'TARGET_CPA' || strategyType === 'MAXIMIZE_CONVERSIONS');
      var conversions = camp.getStatsFor('ALL_TIME').getConversions();
      
      var needsUpgrade = false;
      
      // Случай 1: Кампания еще на ручной ставке
      if (!isConversionStrategy && conversions >= CONFIG.MIN_CONVERSIONS_FOR_CPA) {
        needsUpgrade = true;
      } 
      // Случай 2: Кампания уже переключена, но Target CPA не задан или отличается от конфига
      else if (strategyType === 'MAXIMIZE_CONVERSIONS' && targetCpaMicros !== expectedMicros && conversions >= CONFIG.MIN_CONVERSIONS_FOR_CPA) {
        needsUpgrade = true;
      }

      if (needsUpgrade) {
        Logger.log('[BID_UPGRADE] 📈 Обработка кампании "' + camp.getName() + '" (' + conversions + ' конв.). Применяем Target CPA = ' + CONFIG.TARGET_CPA);
        try {
          // ОДИН прямой запрос, который меняет И стратегию, И ставку одновременно
          AdsApp.mutate({
            campaignOperation: {
              update: {
                resourceName: 'customers/' + customerId + '/campaigns/' + camp.getId(),
                maximizeConversions: { targetCpaMicros: expectedMicros }
              },
              updateMask: 'maximizeConversions' // Указываем Гуглу применить весь объект стратегии целиком
            }
          });
          
          upgradedCount++;
          isConversionStrategy = true; // Отмечаем для демографии ниже
          Logger.log('[BID_UPGRADE] ✅ Стратегия и ставка успешно установлены!');
        } catch (e) {
          Logger.log('[BID_UPGRADE] ❌ Ошибка переключения: ' + e.message);
        }
      }

      // Если кампания стала конверсионной, открываем возраст "Неизвестно"
      if (isConversionStrategy) {
        try {
          var qDemo = "SELECT ad_group_criterion.resource_name, ad_group.name " +
                      "FROM ad_group_criterion " +
                      "WHERE campaign.id = " + camp.getId() + " " +
                      "AND ad_group_criterion.type = 'AGE_RANGE' " +
                      "AND ad_group_criterion.negative = TRUE " +
                      "AND ad_group_criterion.age_range.type = 'AGE_RANGE_UNDETERMINED'";
          
          var searchDemo = AdsApp.search(qDemo);
          while (searchDemo.hasNext()) {
            var rowDemo = searchDemo.next();
            AdsApp.mutate({ adGroupCriterionOperation: { remove: rowDemo.ad_group_criterion.resource_name } });
            Logger.log('[DEMOGRAPHICS] 🔓 Разрешен возраст "Неизвестно" в группе: ' + rowDemo.ad_group.name);
          }
        } catch(e) {}
      }
    }
    
    if (upgradedCount === 0) {
      Logger.log('[BID_UPGRADE] Изменение ставок пока не требуется.');
    }
  }
