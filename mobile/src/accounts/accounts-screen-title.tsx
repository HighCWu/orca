import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-accounts-screen-styles'

export function AccountsScreenTitle({ hostName }: { hostName: string | null | undefined }) {
  const t = useMobileTranslation()
  return (
    <View style={styles.titleWrap}>
      <Text style={styles.heading}>{t('accounts.screen.title', 'Accounts')}</Text>
      {hostName ? (
        <Text style={styles.subheading} numberOfLines={1}>
          {hostName}
        </Text>
      ) : null}
    </View>
  )
}
