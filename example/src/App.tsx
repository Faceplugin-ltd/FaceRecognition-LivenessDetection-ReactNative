import { useEffect } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { startEngine } from './engine';
import { loadSettings } from './data/settings';
import type { RootStackParamList } from './navigation';
import { colors } from './theme';
import { ToastHost } from './ui/Toast';
import SplashScreen from './screens/SplashScreen';
import MainTabs from './screens/MainTabs';
import ResultScreen from './screens/ResultScreen';
import MatchesScreen from './screens/MatchesScreen';
import AttributeResultScreen from './screens/AttributeResultScreen';
import AddPersonScreen from './screens/AddPersonScreen';
import ImportScreen from './screens/ImportScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.background,
    card: colors.surface,
    text: colors.onSurface,
    primary: colors.primary,
    border: colors.outlineVariant,
  },
};

export default function App() {
  useEffect(() => {
    // Activation + init run in the background while the splash shows.
    startEngine();
    loadSettings();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={colors.surface} />
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <NavigationContainer theme={navTheme}>
          <Stack.Navigator
            initialRouteName="Splash"
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen
              name="Splash"
              component={SplashScreen}
              options={{ animation: 'fade' }}
            />
            <Stack.Screen
              name="Main"
              component={MainTabs}
              options={{ animation: 'fade' }}
            />
            <Stack.Screen name="Result" component={ResultScreen} />
            <Stack.Screen name="Matches" component={MatchesScreen} />
            <Stack.Screen
              name="AttributeResult"
              component={AttributeResultScreen}
            />
            <Stack.Screen name="AddPerson" component={AddPersonScreen} />
            <Stack.Screen name="Import" component={ImportScreen} />
          </Stack.Navigator>
        </NavigationContainer>
        <ToastHost />
      </View>
    </SafeAreaProvider>
  );
}
