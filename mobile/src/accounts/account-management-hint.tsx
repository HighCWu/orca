import { Text, View } from 'react-native'
import { User } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'

export function AccountManagementHint() {
  const t = useMobileTranslation()
  return (
    <View style={styles.footerHint}>
      <User size={14} color={colors.textMuted} />
      <Text style={styles.footerHintText}>
        {t(
          'accounts.screen.manageAccountsHint',
          'Add or re-authenticate accounts from desktop Settings → Accounts.'
        )}
      </Text>
    </View>
  )
}
